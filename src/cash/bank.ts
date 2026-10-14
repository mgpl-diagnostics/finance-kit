import { createHash } from "node:crypto";
import {
  ConflictError, NotFoundError, ValidationError, type BankLine, type BankStatement, type Id, type LedgerEntry, type Repositories,
} from "@mgpl-diagnostics/db-kit";
import { financeConfig } from "../config";
import { balanceOf, ledgerId, line, post } from "../posting";
import { lockDateFor } from "../periods/locks";
import { addDays, applyBp, istDay, startOfIstDay } from "../util";

// ------------------------------------------------------------------ CSV parsing

/** RFC 4180 CSV → rows of fields (quotes, doubled quotes, CR/LF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

/** "1,23,456.78" / "(12.50)" / "12.50 Dr" → paise (string arithmetic, no floats). null when empty. */
export function parseAmount(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  let s = raw.replace(/[,\s]|INR|Rs\.?|₹/gi, "");
  if (!s || s === "-") return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  if (/dr$/i.test(s)) { sign = -sign; s = s.slice(0, -2); } else if (/cr$/i.test(s)) s = s.slice(0, -2);
  if (s.startsWith("-")) { sign = -sign; s = s.slice(1); } else if (s.startsWith("+")) s = s.slice(1);
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new ValidationError(`Not an amount: "${raw}"`);
  return sign * (Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0")));
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** "14/10/2026", "14-10-26", "14.10.2026", "2026-10-14", "14-Oct-2026", "14 Oct 2026" → IST day. Indian banks write day first. */
export function parseDay(raw: string): string {
  const s = raw.trim();
  let y: number, m: number, d: number;
  let r: RegExpExecArray | null;
  if ((r = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s))) [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{1,2})[\s/-]([A-Za-z]{3})[A-Za-z]*[\s/-](\d{2,4})$/.exec(s)) && MONTHS[r[2]!.toLowerCase()]) [d, m, y] = [Number(r[1]), MONTHS[r[2]!.toLowerCase()]!, Number(r[3])];
  else throw new ValidationError(`Not a date: "${raw}"`);
  if (y < 100) y += 2000;
  const day = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  startOfIstDay(day); // validates
  return day;
}

export interface ParsedBankLine {
  day: string;
  description: string;
  reference?: string;
  debitPaise: number;
  creditPaise: number;
  balancePaise?: number | null;
}

const HEADERS = {
  date: ["txn date", "transaction date", "tran date", "date", "value date", "posting date"],
  description: ["description", "narration", "particulars", "remarks", "transaction details", "details"],
  reference: ["chq/ref no", "chq./ref.no.", "ref no", "reference", "reference no", "cheque no", "chq no", "utr", "utr no"],
  debit: ["debit", "withdrawal", "withdrawal amt", "withdrawals", "debit amount", "dr"],
  credit: ["credit", "deposit", "deposit amt", "deposits", "credit amount", "cr"],
  amount: ["amount", "transaction amount"],
  type: ["type", "dr/cr", "cr/dr", "debit/credit"],
  balance: ["balance", "closing balance", "running balance", "available balance"],
};
type Col = keyof typeof HEADERS;
const norm = (h: string) => h.toLowerCase().replace(/\(.*?\)/g, "").replace(/\./g, " ").replace(/\s+/g, " ").trim();

/**
 * Reads a bank statement CSV. Finds the header row (skipping bank preamble lines), then the columns by
 * their usual names: date, description, reference, debit/credit (or amount + Dr/Cr type), balance.
 * Pass `columns` to name them yourself.
 */
export function parseBankCsv(text: string, columns?: Partial<Record<Col, string>>): ParsedBankLine[] {
  const rows = parseCsv(text);
  const find = (header: string[]): Partial<Record<Col, number>> => {
    const h = header.map(norm);
    const out: Partial<Record<Col, number>> = {};
    for (const col of Object.keys(HEADERS) as Col[]) {
      const names = (columns?.[col] ? [columns[col]!] : HEADERS[col]).map(norm);
      for (const n of names) {
        const i = h.indexOf(n);
        if (i >= 0 && !Object.values(out).includes(i)) { out[col] = i; break; }
      }
    }
    return out;
  };
  const headerAt = rows.findIndex((r) => {
    const c = find(r);
    return c.date !== undefined && (c.debit !== undefined || c.credit !== undefined || c.amount !== undefined);
  });
  if (headerAt < 0) throw new ValidationError("No header row with a date and debit/credit (or amount) columns");
  const c = find(rows[headerAt]!);
  const out: ParsedBankLine[] = [];
  for (const r of rows.slice(headerAt + 1)) {
    const dateCell = r[c.date!]?.trim();
    if (!dateCell || !/\d/.test(dateCell)) continue; // totals / footer lines
    let debit = c.debit !== undefined ? parseAmount(r[c.debit]) ?? 0 : 0;
    let credit = c.credit !== undefined ? parseAmount(r[c.credit]) ?? 0 : 0;
    if (c.amount !== undefined && c.debit === undefined && c.credit === undefined) {
      const amt = parseAmount(r[c.amount]) ?? 0;
      const t = c.type !== undefined ? r[c.type]!.trim().toLowerCase() : "";
      if (t.startsWith("d")) debit = Math.abs(amt);
      else if (t.startsWith("c")) credit = Math.abs(amt);
      else if (amt < 0) debit = -amt;
      else credit = amt;
    }
    if (debit < 0 || credit < 0) [debit, credit] = [Math.max(0, -credit, debit), Math.max(0, -debit, credit)];
    if (debit === 0 && credit === 0) continue;
    if (debit > 0 && credit > 0) throw new ValidationError(`A line has both a debit and a credit: ${r.join(",")}`);
    out.push({
      day: parseDay(dateCell), description: (c.description !== undefined ? r[c.description] ?? "" : "").trim(),
      reference: c.reference !== undefined ? r[c.reference]?.trim() || undefined : undefined,
      debitPaise: debit, creditPaise: credit, balancePaise: c.balance !== undefined ? parseAmount(r[c.balance]) : null,
    });
  }
  return out;
}

// ------------------------------------------------------------------ import

/** Same day: by reference, description and amount, so matching does not depend on ids or storage order. */
function byStatementOrder(a: BankLine, b: BankLine): number {
  return a.date.getTime() - b.date.getTime() || (a.reference ?? "").localeCompare(b.reference ?? "") || a.description.localeCompare(b.description)
    || a.creditPaise - b.creditPaise || a.debitPaise - b.debitPaise || a.dedupKey.localeCompare(b.dedupKey);
}

export interface ImportInput {
  orgId: Id;
  branchId: Id;
  /** The bank ledger (e.g. system key "bank"). */
  ledgerId: Id;
  fileName?: string;
  csv?: string;
  lines?: ParsedBankLine[];
}

/**
 * Stores a statement and its lines. Each line gets a dedup key (ledger, day, amounts, reference,
 * description, and its occurrence number in the file), so importing the same file again adds nothing.
 */
export async function importBankStatement(repos: Repositories, input: ImportInput, actorId?: Id): Promise<{ statement: BankStatement; added: number; skipped: number }> {
  const lines = input.lines ?? (input.csv !== undefined ? parseBankCsv(input.csv) : []);
  if (!lines.length) throw new ValidationError("The statement has no lines");
  const seen = new Map<string, number>();
  const keyed = lines.map((l) => {
    const base = [input.ledgerId, l.day, l.debitPaise, l.creditPaise, l.reference ?? "", l.description].join("|");
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...l, dedupKey: createHash("sha256").update(`${base}|${n}`).digest("hex") };
  });
  return repos.transaction(async (tx) => {
    const ledger = await tx.ledgers.get(input.ledgerId);
    if (!ledger || ledger.orgId !== input.orgId) throw new NotFoundError("Ledger", input.ledgerId);
    const days = keyed.map((l) => l.day).sort();
    const withBalance = keyed.filter((l) => l.balancePaise != null);
    const statement = await tx.bankStatements.create({
      orgId: input.orgId, branchId: input.branchId, ledgerId: input.ledgerId, fileName: input.fileName, from: startOfIstDay(days[0]!), to: startOfIstDay(days.at(-1)!),
      openingPaise: withBalance.length ? withBalance[0]!.balancePaise! - withBalance[0]!.creditPaise + withBalance[0]!.debitPaise : null,
      closingPaise: withBalance.length ? withBalance.at(-1)!.balancePaise! : null, lineCount: keyed.length, importedBy: actorId ?? null,
    });
    let added = 0;
    for (const l of keyed) {
      if (await tx.bankLines.findOne({ orgId: input.orgId, dedupKey: l.dedupKey })) continue;
      await tx.bankLines.create({
        orgId: input.orgId, statementId: statement.id, ledgerId: input.ledgerId, date: startOfIstDay(l.day), description: l.description, reference: l.reference,
        debitPaise: l.debitPaise, creditPaise: l.creditPaise, balancePaise: l.balancePaise ?? null, dedupKey: l.dedupKey, status: "unmatched", voucherIds: [],
      });
      added++;
    }
    await tx.audit.log({ orgId: input.orgId, branchId: input.branchId, userId: actorId ?? null, action: "finance.bank.import", entity: "bank_statement", entityId: statement.id, data: { added, skipped: keyed.length - added } });
    return { statement, added, skipped: keyed.length - added };
  });
}

// ------------------------------------------------------------------ matching

const lineDay = (l: Pick<BankLine, "date">) => istDay(l.date);
const dist = (a: string, b: string) => Math.abs((startOfIstDay(a).getTime() - startOfIstDay(b).getTime()) / 86400000);

/** Voucher ids already matched to some bank line of this ledger. */
async function matchedVoucherIds(repos: Repositories, ledgerId: Id): Promise<Set<Id>> {
  const lines = await repos.bankLines.find({ ledgerId, status: "matched" });
  return new Set(lines.flatMap((l) => l.voucherIds));
}

/**
 * Matches unmatched bank lines with the books, in one transaction:
 * 1. **Entries:** a line equal to one posting on the bank ledger (credit ↔ debit, debit ↔ credit),
 *    dated within `toleranceDays`, not matched before; the reference in the narration wins, then
 *    the nearest date.
 * 2. **Card / UPI settlements:** a bank credit that equals one day's net receipts on a clearing
 *    ledger (UPI Collections, Card Settlements) less a fee of at most `maxFeeBp`. It posts a Contra:
 *    Dr Bank (amount), Dr Bank Charges (fee), Cr the clearing ledger (gross), and matches it.
 */
export async function reconcileBank(repos: Repositories, input: { orgId: Id; ledgerId: Id; statementId?: Id }, actorId?: Id) {
  const cfg = await financeConfig(repos, input.orgId);
  return repos.transaction(async (tx) => {
    const lines = (await tx.bankLines.find({ ledgerId: input.ledgerId, status: "unmatched", ...(input.statementId ? { statementId: input.statementId } : {}) }))
      .filter((l) => l.orgId === input.orgId)
      .sort(byStatementOrder);
    if (!lines.length) return { matched: 0, settlements: 0, unmatched: 0 };
    const used = await matchedVoucherIds(tx, input.ledgerId);
    const first = addDays(lineDay(lines[0]!), -cfg.bank.toleranceDays - 7);
    const last = addDays(lineDay(lines.at(-1)!), cfg.bank.toleranceDays);
    const window = { orgId: input.orgId, from: startOfIstDay(first), to: startOfIstDay(addDays(last, 1)) };
    const book = await tx.ledgerEntries.list({ ...window, ledgerId: input.ledgerId });
    const narrations = new Map<Id, string>();
    const narration = async (voucherId: Id) => {
      if (!narrations.has(voucherId)) narrations.set(voucherId, (await tx.vouchers.get(voucherId))?.narration ?? "");
      return narrations.get(voucherId)!;
    };

    // clearing ledgers: net receipts per IST day, and the days already settled
    const clearing = [];
    for (const key of cfg.bank.clearingLedgerKeys) {
      const l = await tx.ledgers.findBySystemKey(input.orgId, key);
      if (!l) continue;
      const entries = await tx.ledgerEntries.list({ ...window, ledgerId: l.id });
      const daily = new Map<string, number>();
      for (const e of entries) if (e.voucherType !== "contra") daily.set(istDay(e.date), (daily.get(istDay(e.date)) ?? 0) + e.debitPaise - e.creditPaise);
      clearing.push({ ledgerId: l.id, daily });
    }
    const settled = new Set((await tx.bankLines.find({ ledgerId: input.ledgerId, status: "matched", matchKind: "settlement" })).map((l) => `${l.settlement!.ledgerId}|${l.settlement!.day}`));
    const charges = await ledgerId(tx, input.orgId, "bank_charges");

    let matched = 0;
    let settlements = 0;
    for (const bl of lines) {
      const day = lineDay(bl);
      const amount = bl.creditPaise || bl.debitPaise;
      const candidates: LedgerEntry[] = book.filter((e) =>
        !used.has(e.voucherId) && (bl.creditPaise ? e.debitPaise === amount : e.creditPaise === amount) && dist(istDay(e.date), day) <= cfg.bank.toleranceDays);
      if (candidates.length) {
        const ref = bl.reference?.toLowerCase();
        const scored = await Promise.all(candidates.map(async (e) => ({ e, hit: Boolean(ref && (await narration(e.voucherId)).toLowerCase().includes(ref)), d: dist(istDay(e.date), day) })));
        scored.sort((a, b) => Number(b.hit) - Number(a.hit) || a.d - b.d || a.e.voucherNo.localeCompare(b.e.voucherNo));
        const pick = scored[0]!.e;
        used.add(pick.voucherId);
        await tx.bankLines.update(bl.id, { status: "matched", matchKind: "entry", voucherIds: [pick.voucherId], matchedBy: actorId ?? null, matchedAt: new Date() });
        matched++;
        continue;
      }
      if (!bl.creditPaise) continue;
      // settlement of an earlier day's card / UPI receipts, net of the fee
      let found: { ledgerId: Id; day: string; gross: number } | undefined;
      for (let back = 0; back <= cfg.bank.toleranceDays + 7 && !found; back++) {
        const d = addDays(day, -back);
        for (const c of clearing) {
          const gross = c.daily.get(d) ?? 0;
          const fee = gross - bl.creditPaise;
          if (gross > 0 && !settled.has(`${c.ledgerId}|${d}`) && fee >= 0 && fee <= applyBp(gross, cfg.bank.maxFeeBp)) { found = { ledgerId: c.ledgerId, day: d, gross }; break; }
        }
      }
      if (!found) continue;
      const fee = found.gross - bl.creditPaise;
      const statement = await tx.bankStatements.get(bl.statementId);
      // dated the bank's day; if that day is already locked (e.g. its cash is closed), the first open instant
      const lock = await lockDateFor(tx, input.orgId, statement!.branchId);
      const date = !lock || bl.date.getTime() > lock.getTime() ? bl.date : new Date(Math.max(Date.now(), lock.getTime() + 1));
      const voucher = await post(tx, {
        orgId: input.orgId, branchId: statement!.branchId, type: "contra", date,
        narration: `Settlement of ${found.day} receipts${bl.reference ? ` ref ${bl.reference}` : ""}: gross ${found.gross}, fee ${fee} paise`,
        entries: [line(input.ledgerId, bl.creditPaise), line(charges, fee), line(found.ledgerId, -found.gross)].filter((e) => e.debitPaise > 0 || e.creditPaise > 0),
      }, actorId);
      settled.add(`${found.ledgerId}|${found.day}`);
      used.add(voucher.id);
      await tx.bankLines.update(bl.id, {
        status: "matched", matchKind: "settlement", voucherIds: [voucher.id], settlement: { ledgerId: found.ledgerId, day: found.day, grossPaise: found.gross, feePaise: fee },
        matchedBy: actorId ?? null, matchedAt: new Date(),
      });
      settlements++;
    }
    return { matched, settlements, unmatched: lines.length - matched - settlements };
  });
}

/** Matches a line by hand with vouchers whose postings on the bank ledger add up to the line. */
export async function matchBankLine(repos: Repositories, input: { orgId: Id; lineId: Id; voucherIds: Id[] }, actorId?: Id): Promise<BankLine> {
  return repos.transaction(async (tx) => {
    const bl = await tx.bankLines.get(input.lineId);
    if (!bl || bl.orgId !== input.orgId) throw new NotFoundError("Bank line", input.lineId);
    if (bl.status === "matched") throw new ConflictError("The line is already matched");
    const used = await matchedVoucherIds(tx, bl.ledgerId);
    let net = 0;
    for (const id of input.voucherIds) {
      if (used.has(id)) throw new ConflictError(`Voucher ${id} is already matched`);
      const v = await tx.vouchers.get(id);
      if (!v || v.orgId !== input.orgId || v.status !== "posted") throw new NotFoundError("Posted voucher", id);
      for (const e of v.entries) if (e.ledgerId === bl.ledgerId) net += e.debitPaise - e.creditPaise;
    }
    if (net !== bl.creditPaise - bl.debitPaise) throw new ValidationError(`The vouchers move ${net} paise on the bank ledger; the line is ${bl.creditPaise - bl.debitPaise}`);
    return (await tx.bankLines.update(bl.id, { status: "matched", matchKind: "manual", voucherIds: input.voucherIds, matchedBy: actorId ?? null, matchedAt: new Date() }))!;
  });
}

/** Marks a line as not needing a match (e.g. a reversal pair), or undoes a manual / entry match. */
export async function setBankLineStatus(repos: Repositories, input: { orgId: Id; lineId: Id; status: "ignored" | "unmatched" }, actorId?: Id): Promise<BankLine> {
  const bl = await repos.bankLines.get(input.lineId);
  if (!bl || bl.orgId !== input.orgId) throw new NotFoundError("Bank line", input.lineId);
  if (bl.matchKind === "settlement") throw new ConflictError("A settlement match posted a voucher: cancel it before unmatching");
  return (await repos.bankLines.update(bl.id, { status: input.status, matchKind: null, voucherIds: [], matchedBy: actorId ?? null, matchedAt: input.status === "ignored" ? new Date() : null }))!;
}

/**
 * Bank reconciliation statement at a date:
 *   balance per bank = balance per books + payments not yet presented − deposits not yet credited
 *                      + bank credits not in the books − bank debits not in the books
 * `differencePaise` is 0 when everything is explained (needs balances in the statement).
 */
export async function bankReconciliation(repos: Repositories, q: { orgId: Id; ledgerId: Id; asOf: Date }) {
  const lines = (await repos.bankLines.find({ ledgerId: q.ledgerId })).filter((l) => l.orgId === q.orgId && l.date.getTime() <= q.asOf.getTime());
  lines.sort(byStatementOrder);
  const matched = new Set(lines.filter((l) => l.status === "matched").flatMap((l) => l.voucherIds));
  const entries = await repos.ledgerEntries.list({ orgId: q.orgId, ledgerId: q.ledgerId, to: q.asOf });
  const unreconciled = entries.filter((e) => !matched.has(e.voucherId));
  const bookPaise = await balanceOf(repos, { orgId: q.orgId, ledgerId: q.ledgerId, asOf: q.asOf });
  const withBalance = lines.filter((l) => l.balancePaise != null);
  const bankPaise = withBalance.length ? withBalance.at(-1)!.balancePaise! : null;
  const open = lines.filter((l) => l.status === "unmatched");
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const notPresented = sum(unreconciled.map((e) => e.creditPaise));
  const notCredited = sum(unreconciled.map((e) => e.debitPaise));
  const bankCredits = sum(open.map((l) => l.creditPaise));
  const bankDebits = sum(open.map((l) => l.debitPaise));
  const expected = bookPaise + notPresented - notCredited + bankCredits - bankDebits;
  return {
    bookPaise,
    bankPaise,
    paymentsNotPresentedPaise: notPresented,
    depositsNotCreditedPaise: notCredited,
    bankCreditsNotInBooksPaise: bankCredits,
    bankDebitsNotInBooksPaise: bankDebits,
    expectedBankPaise: expected,
    differencePaise: bankPaise === null ? null : bankPaise - expected,
    reconciled: { lines: lines.filter((l) => l.status === "matched").length, amountPaise: sum(lines.filter((l) => l.status === "matched").map((l) => l.creditPaise - l.debitPaise)) },
    unmatchedLines: open,
    unreconciledEntries: unreconciled,
  };
}
