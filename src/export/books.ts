import { NotFoundError, type Id, type Repositories } from "@mgpl-diagnostics/db-kit";
import { balanceSheet, dayBook, ledgerStatement, profitAndLoss, trialBalance } from "../posting";
import { istDay } from "../util";
import { rupees, toCsv } from "./csv";

/**
 * Books exports. Each one ends with a TOTAL row equal to the report it comes from (tests check it).
 */

interface Range {
  orgId: Id;
  branchId?: Id;
  from: Date;
  to: Date;
}

/** Day book: one row per voucher line; cancelled vouchers are listed with their status and left out of the totals. */
export async function dayBookCsv(repos: Repositories, q: Range & { bom?: boolean }): Promise<string> {
  const vouchers = await dayBook(repos, q);
  const names = new Map((await repos.ledgers.find({ orgId: q.orgId })).map((l) => [l.id, l.name]));
  let dr = 0;
  let cr = 0;
  const rows = vouchers.flatMap((v) => v.entries.map((e) => {
    if (v.status === "posted") { dr += e.debitPaise; cr += e.creditPaise; }
    return [istDay(v.date), v.voucherNo, v.type, v.status, names.get(e.ledgerId) ?? e.ledgerId, rupees(e.debitPaise, true), rupees(e.creditPaise, true), v.narration ?? ""];
  }));
  rows.push(["", "", "", "", "TOTAL (posted)", rupees(dr), rupees(cr), ""]);
  return toCsv(["Date", "Voucher No", "Type", "Status", "Ledger", "Debit", "Credit", "Narration"], rows, q);
}

/** A ledger account: opening, every posting with running balance (Dr / Cr), closing. */
export async function ledgerCsv(repos: Repositories, q: Range & { ledgerId: Id; bom?: boolean }): Promise<string> {
  const ledger = await repos.ledgers.get(q.ledgerId);
  if (!ledger || ledger.orgId !== q.orgId) throw new NotFoundError("Ledger", q.ledgerId);
  const s = await ledgerStatement(repos, q);
  const side = (p: number) => (p === 0 ? "" : p > 0 ? "Dr" : "Cr");
  const rows = [
    ["", "", "Opening balance", "", "", rupees(Math.abs(s.openingPaise)), side(s.openingPaise)],
    ...s.rows.map((r) => [istDay(r.date), r.voucherNo, r.voucherType, rupees(r.debitPaise, true), rupees(r.creditPaise, true), rupees(Math.abs(r.balancePaise)), side(r.balancePaise)]),
    ["", "", "TOTAL", rupees(s.totalDebitPaise), rupees(s.totalCreditPaise), "", ""],
    ["", "", "Closing balance", "", "", rupees(Math.abs(s.closingPaise)), side(s.closingPaise)],
  ];
  return toCsv([`Ledger: ${s.ledger.name}`, "Voucher No", "Type", "Debit", "Credit", "Balance", "Dr/Cr"], rows, q);
}

export async function trialBalanceCsv(repos: Repositories, q: { orgId: Id; branchId?: Id; asOf?: Date; bom?: boolean }): Promise<string> {
  const tb = await trialBalance(repos, q);
  const rows = tb.rows.map((r) => [r.primaryGroup.name, r.group.name, r.ledger.name, rupees(r.debitPaise, true), rupees(r.creditPaise, true)]);
  rows.push(["", "", "TOTAL", rupees(tb.totalDebitPaise), rupees(tb.totalCreditPaise)]);
  return toCsv(["Primary group", "Group", "Ledger", "Debit", "Credit"], rows, q);
}

export async function profitAndLossCsv(repos: Repositories, q: Range & { bom?: boolean }): Promise<string> {
  const pl = await profitAndLoss(repos, q);
  const rows: string[][] = [];
  for (const [side, lines] of [["Income", pl.income], ["Expenses", pl.expenses]] as const)
    for (const g of [...lines].sort((a, b) => a.group.name.localeCompare(b.group.name)))
      for (const l of [...g.ledgers].sort((a, b) => a.ledger.name.localeCompare(b.ledger.name))) rows.push([side, g.group.name, l.ledger.name, rupees(l.amountPaise)]);
  rows.push(["", "", "Gross profit", rupees(pl.grossProfitPaise)], ["", "", "Net profit", rupees(pl.netProfitPaise)]);
  return toCsv(["Side", "Group", "Ledger", "Amount"], rows, q);
}

export async function balanceSheetCsv(repos: Repositories, q: { orgId: Id; branchId?: Id; asOf: Date; bom?: boolean }): Promise<string> {
  const bs = await balanceSheet(repos, q);
  const rows: string[][] = [];
  for (const [side, lines] of [["Liabilities", bs.liabilities], ["Assets", bs.assets]] as const)
    for (const g of [...lines].sort((a, b) => a.group.name.localeCompare(b.group.name)))
      for (const l of [...g.ledgers].sort((a, b) => a.ledger.name.localeCompare(b.ledger.name))) rows.push([side, g.group.name, l.ledger.name, rupees(l.amountPaise)]);
  rows.push(["Liabilities", "", "Profit to date", rupees(bs.profitPaise)]);
  rows.push(["", "", "TOTAL liabilities", rupees(bs.totalLiabilitiesPaise)], ["", "", "TOTAL assets", rupees(bs.totalAssetsPaise)]);
  return toCsv(["Side", "Group", "Ledger", "Amount"], rows, q);
}

/** A partner's settlement statement. */
export async function settlementCsv(repos: Repositories, q: { orgId: Id; settlementId: Id; bom?: boolean }): Promise<string> {
  const s = await repos.settlements.get(q.settlementId);
  if (!s || s.orgId !== q.orgId) throw new NotFoundError("Settlement", q.settlementId);
  const rows: string[][] = s.lines.map((l) => [l.day, l.invoiceNo, l.code ?? "", l.name, rupees(l.netPaise), rupees(l.sharePaise)]);
  rows.push(["", "", "", "TOTAL", rupees(s.grossPaise), rupees(s.sharePaise)]);
  for (const d of s.deductions) rows.push(["", "", "", `Less: ${d.label}`, "", rupees(-d.amountPaise)]);
  rows.push(["", "", "", `Less: TDS ${s.tdsSection ?? ""} @ ${s.tdsRateBp / 100}% on ${rupees(s.tdsBasePaise)}`, "", rupees(-s.tdsPaise)]);
  rows.push(["", "", "", "NET PAYABLE", "", rupees(s.netPaise)]);
  return toCsv(["Date", "Invoice No", "Code", "Test", "Net billed", "Share"], rows, q);
}
