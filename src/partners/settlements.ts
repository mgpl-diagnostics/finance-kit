import {
  ConflictError, NotFoundError, ValidationError, type Id, type Invoice, type ItemCategory, type Partner, type PartnerAgreement, type PaymentMode,
  type Repositories, type Settlement, type SettlementDeduction, type SettlementLine,
} from "@mgpl-diagnostics/db-kit";
import { financeConfig, type FinanceConfig } from "../config";
import { invoiceTaxLines } from "../gst/breakup";
import { cancel, ledgerId, ledgerIds, line, MODE_LEDGER, post } from "../posting";
import { applyBp, divRound, fyOf, istDay, monthRange } from "../util";
import { agreementOn } from "./partners";

const DEFAULT_CATEGORIES: ItemCategory[] = ["test", "package"];

export interface TdsResult {
  section: string | null;
  rateBp: number;
  basePaise: number;
  tdsPaise: number;
}

/**
 * TDS on a partner's share (all values configuration; verify with CA):
 * - rate: the partner's override, else the default rate (with a PAN) or the no-PAN rate;
 * - nothing is deducted until the partner's shares in the financial year exceed the threshold; the
 *   settlement that crosses it deducts on the whole year so far (earlier shares not yet taxed included);
 * - TDS is rounded to the nearest rupee.
 */
export function computeTds(input: { sharePaise: number; priorSharePaise: number; priorBasePaise: number; partner: Pick<Partner, "pan" | "tds">; config: FinanceConfig["tds"] }): TdsResult {
  const { partner, config } = input;
  const section = partner.tds?.section ?? config.section;
  const rateBp = partner.tds?.rateBp ?? (partner.pan ? config.rateBp : config.noPanRateBp);
  const crossed = config.thresholdPaise === null || input.priorSharePaise + input.sharePaise > config.thresholdPaise;
  const basePaise = crossed ? Math.max(0, input.sharePaise + input.priorSharePaise - input.priorBasePaise) : 0;
  return { section, rateBp, basePaise, tdsPaise: divRound(basePaise * rateBp, 1_000_000) * 100 };
}

/** A fixed-rate agreement's amount for one invoice line. */
function fixedShare(ag: PartnerAgreement, code: string | undefined, qty: number): number {
  const per = (code ? ag.rates?.find((r) => r.code === code)?.sharePaise : undefined) ?? ag.defaultSharePaise ?? 0;
  return Math.round(per * qty);
}

export interface SettlementCalc {
  partner: Partner;
  period: string;
  from: Date;
  to: Date;
  lines: SettlementLine[];
  grossPaise: number;
  sharePaise: number;
  deductions: SettlementDeduction[];
  deductionsPaise: number;
  tds: TdsResult;
  netPaise: number;
  /** Invoices of the month with no agreement in force on their date. */
  uncoveredInvoices: string[];
}

/**
 * A partner's month, computed from the invoices of its branch: each eligible line earns the share of
 * the agreement in force on the invoice date (revenue share: bp of the line's net billed value, after
 * line and bill discounts and before GST, rounded per line; fixed rate: amount × quantity). Credit
 * notes dated in the month take back the share in proportion to the value credited.
 */
export async function computeSettlement(repos: Repositories, input: { orgId: Id; partnerId: Id; period: string; deductions?: SettlementDeduction[] }): Promise<SettlementCalc> {
  const partner = await repos.partners.get(input.partnerId);
  if (!partner || partner.orgId !== input.orgId) throw new NotFoundError("Partner", input.partnerId);
  const { from, to } = monthRange(input.period);
  const cfg = await financeConfig(repos, input.orgId);
  const agreements = await repos.partnerAgreements.find({ partnerId: partner.id });
  const lines: SettlementLine[] = [];
  const uncovered: string[] = [];
  const eligible = (ag: PartnerAgreement, c: ItemCategory) => (ag.categories ?? DEFAULT_CATEGORIES).includes(c);

  const invoices = await repos.invoices.listByDate({ orgId: input.orgId, branchId: partner.branchId, from, to });
  for (const inv of invoices) {
    const at = inv.issuedAt ?? inv.createdAt;
    const ag = agreementOn(agreements, at);
    if (!ag) { uncovered.push(inv.invoiceNo); continue; }
    for (const t of invoiceTaxLines(inv, false)) {
      if (!eligible(ag, t.category)) continue;
      const share = ag.kind === "revenue_share" ? applyBp(t.taxablePaise, ag.shareBp ?? 0) : fixedShare(ag, t.code, t.qty);
      lines.push({ invoiceId: inv.id, invoiceNo: inv.invoiceNo, day: istDay(at), code: t.code, name: t.name, netPaise: t.taxablePaise, sharePaise: share, agreementId: ag.id, creditNoteId: null });
    }
  }

  const notes = await repos.creditNotes.listByDate({ orgId: input.orgId, branchId: partner.branchId, from, to });
  const originals = new Map<Id, Invoice>((await repos.invoices.getMany([...new Set(notes.map((n) => n.invoiceId))])).map((i) => [i.id, i]));
  for (const note of notes) {
    const inv = originals.get(note.invoiceId)!;
    const ag = agreementOn(agreements, inv.issuedAt ?? inv.createdAt);
    if (!ag) continue;
    const tax = invoiceTaxLines(inv, false);
    for (const l of note.lines) {
      const t = tax[l.itemIndex]!;
      if (!eligible(ag, t.category)) continue;
      const full = ag.kind === "revenue_share" ? null : fixedShare(ag, t.code, t.qty);
      const share = full === null ? -applyBp(l.taxablePaise, ag.shareBp ?? 0) : t.taxablePaise > 0 ? -divRound(full * l.taxablePaise, t.taxablePaise) : 0;
      lines.push({ invoiceId: inv.id, invoiceNo: inv.invoiceNo, day: istDay(note.date), code: t.code, name: `${t.name} (credit note ${note.noteNo})`, netPaise: -l.taxablePaise, sharePaise: share, agreementId: ag.id, creditNoteId: note.id });
    }
  }

  const deductions = (input.deductions ?? []).map((d) => {
    if (!d.label?.trim() || !(Number.isSafeInteger(d.amountPaise) && d.amountPaise > 0)) throw new ValidationError("Each deduction needs a label and a positive amount in paise");
    return { label: d.label.trim(), amountPaise: d.amountPaise, ledgerId: d.ledgerId ?? null };
  });
  for (const d of deductions) {
    if (!d.ledgerId) continue;
    const l = await repos.ledgers.get(d.ledgerId);
    if (!l || l.orgId !== input.orgId) throw new NotFoundError("Ledger", d.ledgerId);
  }
  const sharePaise = lines.reduce((s, l) => s + l.sharePaise, 0);
  const fy = fyOf(istDay(from));
  const prior = (await repos.settlements.find({ partnerId: partner.id }))
    .filter((s) => (s.status === "accrued" || s.status === "paid") && fyOf(`${s.period}-01`) === fy && s.period < input.period);
  const tds = computeTds({
    sharePaise, priorSharePaise: prior.reduce((s, x) => s + x.sharePaise, 0), priorBasePaise: prior.reduce((s, x) => s + x.tdsBasePaise, 0), partner, config: cfg.tds,
  });
  const deductionsPaise = deductions.reduce((s, d) => s + d.amountPaise, 0);
  return {
    partner, period: input.period, from, to, lines, grossPaise: lines.reduce((s, l) => s + l.netPaise, 0), sharePaise, deductions, deductionsPaise, tds,
    netPaise: sharePaise - deductionsPaise - tds.tdsPaise, uncoveredInvoices: uncovered,
  };
}

const fields = (c: SettlementCalc) => ({
  lines: c.lines, grossPaise: c.grossPaise, sharePaise: c.sharePaise, deductions: c.deductions, deductionsPaise: c.deductionsPaise,
  tdsSection: c.tds.section, tdsRateBp: c.tds.rateBp, tdsBasePaise: c.tds.basePaise, tdsPaise: c.tds.tdsPaise, netPaise: c.netPaise,
});

/** Stores a draft settlement for a partner's month (one live settlement per partner per month). */
export async function createSettlement(repos: Repositories, input: { orgId: Id; partnerId: Id; period: string; deductions?: SettlementDeduction[] }, actorId?: Id): Promise<Settlement> {
  return repos.transaction(async (tx) => {
    const calc = await computeSettlement(tx, input);
    if (await tx.settlements.findOne({ orgId: input.orgId, periodKey: `${calc.partner.id}:${input.period}` })) throw new ConflictError(`A settlement for ${calc.partner.code} ${input.period} already exists`);
    const s = await tx.settlements.create({
      orgId: input.orgId, branchId: calc.partner.branchId, partnerId: calc.partner.id, period: input.period, periodKey: `${calc.partner.id}:${input.period}`,
      from: calc.from, to: calc.to, ...fields(calc), status: "draft", accrualVoucherId: null, payoutVoucherId: null, paidAt: null, createdBy: actorId ?? null,
    });
    await tx.audit.log({ orgId: input.orgId, branchId: s.branchId, userId: actorId ?? null, action: "finance.settlement.create", entity: "settlement", entityId: s.id, data: { period: input.period } });
    return s;
  });
}

/**
 * Recomputes a draft settlement and books it, dated the month's last day:
 *   Dr Collection Centre Share   share        Cr Partner payable   share
 *   Dr Partner payable           TDS          Cr TDS Payable       TDS
 *   Dr Partner payable           deductions   Cr Recoveries (or the deduction's ledger)
 */
export async function accrueSettlement(repos: Repositories, input: { orgId: Id; settlementId: Id; now?: Date }, actorId?: Id): Promise<Settlement> {
  const now = input.now ?? new Date();
  return repos.transaction(async (tx) => {
    const s = await tx.settlements.getForUpdate(input.settlementId);
    if (!s || s.orgId !== input.orgId) throw new NotFoundError("Settlement", input.settlementId);
    if (s.status !== "draft") throw new ConflictError(`Settlement is ${s.status}`);
    if (now.getTime() <= s.to.getTime()) throw new ConflictError(`${s.period} has not ended yet`);
    const calc = await computeSettlement(tx, { orgId: s.orgId, partnerId: s.partnerId, period: s.period, deductions: s.deductions });
    const k = await ledgerIds(tx, s.orgId, ["partner_share", "tds_payable", "partner_recoveries"] as const);
    const payable = calc.partner.ledgerId;
    const entries = [
      line(k.partner_share, calc.sharePaise), line(payable, -calc.sharePaise),
      line(payable, calc.tds.tdsPaise), line(k.tds_payable, -calc.tds.tdsPaise),
      ...calc.deductions.flatMap((d) => [line(payable, d.amountPaise), line(d.ledgerId ?? k.partner_recoveries, -d.amountPaise)]),
    ].filter((e) => e.debitPaise > 0 || e.creditPaise > 0);
    const voucher = entries.length
      ? await post(tx, { orgId: s.orgId, branchId: s.branchId, type: "journal", date: s.to, narration: `Settlement ${calc.partner.code} ${s.period}`, entries }, actorId)
      : null;
    const out = (await tx.settlements.update(s.id, { ...fields(calc), status: "accrued", accrualVoucherId: voucher?.id ?? null }))!;
    await tx.audit.log({ orgId: s.orgId, branchId: s.branchId, userId: actorId ?? null, action: "finance.settlement.accrue", entity: "settlement", entityId: s.id, data: { sharePaise: calc.sharePaise, tdsPaise: calc.tds.tdsPaise, netPaise: calc.netPaise } });
    return out;
  });
}

/** Pays the net amount: Payment voucher Dr Partner payable, Cr Bank / Cash. */
export async function paySettlement(repos: Repositories, input: { orgId: Id; settlementId: Id; mode: PaymentMode; date?: Date; reference?: string }, actorId?: Id): Promise<Settlement> {
  return repos.transaction(async (tx) => {
    const s = await tx.settlements.getForUpdate(input.settlementId);
    if (!s || s.orgId !== input.orgId) throw new NotFoundError("Settlement", input.settlementId);
    if (s.status !== "accrued") throw new ConflictError(`Only an accrued settlement can be paid (this one is ${s.status})`);
    if (s.netPaise <= 0) throw new ConflictError("Nothing to pay: the net amount is not positive");
    const partner = (await tx.partners.get(s.partnerId))!;
    const date = input.date ?? new Date();
    const voucher = await post(tx, {
      orgId: s.orgId, branchId: s.branchId, type: "payment", date,
      narration: `Settlement payout ${partner.code} ${s.period}${input.reference ? ` ref ${input.reference}` : ""}`,
      entries: [line(partner.ledgerId, s.netPaise), line(await ledgerId(tx, s.orgId, MODE_LEDGER[input.mode]), -s.netPaise)],
    }, actorId);
    const out = (await tx.settlements.update(s.id, { status: "paid", payoutVoucherId: voucher.id, paidAt: date }))!;
    await tx.audit.log({ orgId: s.orgId, branchId: s.branchId, userId: actorId ?? null, action: "finance.settlement.pay", entity: "settlement", entityId: s.id, data: { netPaise: s.netPaise, mode: input.mode } });
    return out;
  });
}

/** Cancels a draft or accrued settlement (the accrual voucher is cancelled) and frees its month. */
export async function cancelSettlement(repos: Repositories, input: { orgId: Id; settlementId: Id }, actorId?: Id): Promise<Settlement> {
  return repos.transaction(async (tx) => {
    const s = await tx.settlements.getForUpdate(input.settlementId);
    if (!s || s.orgId !== input.orgId) throw new NotFoundError("Settlement", input.settlementId);
    if (s.status === "cancelled") return s;
    if (s.status === "paid") throw new ConflictError("A paid settlement cannot be cancelled; book a correction in the next month");
    if (s.accrualVoucherId) await cancel(tx, s.accrualVoucherId, actorId);
    const out = (await tx.settlements.update(s.id, { status: "cancelled", periodKey: null }))!;
    await tx.audit.log({ orgId: s.orgId, branchId: s.branchId, userId: actorId ?? null, action: "finance.settlement.cancel", entity: "settlement", entityId: s.id });
    return out;
  });
}
