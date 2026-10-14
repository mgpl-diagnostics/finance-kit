/**
 * THE ONLY MODULE THAT TALKS TO THE ACCOUNTING ENGINE.
 *
 * Today the engine is db-kit's accounting (postVoucher, cancelVoucher, chart of accounts, books
 * reports). When our own accounting kit (tally-kit, working name) takes over, this file switches to
 * it and nothing else in finance-kit changes. `scripts/test.ts` fails if another file imports the
 * engine functions. No Tally software integration of any kind.
 */
import {
  balanceSheet, cancelVoucher, dayBook, ledgerBalance, ledgerStatement, NotFoundError, postVoucher, profitAndLoss, seedChartOfAccounts,
  trialBalance, ValidationError, type Id, type Invoice, type Ledger, type Payment, type PaymentMode, type PostingHook, type Repositories,
  type Voucher, type VoucherEntry, type VoucherType,
} from "@mgpl-diagnostics/db-kit";
import { invoiceTaxLines } from "./gst/breakup";
import { supplyResolver } from "./gst/supply";

export { balanceSheet, dayBook, ledgerBalance, ledgerStatement, profitAndLoss, trialBalance };
export type { Voucher, VoucherEntry, VoucherType };

// ------------------------------------------------------------------ ledgers

/** Ledgers finance-kit adds to db-kit's chart (by system key). */
export const FINANCE_LEDGERS: { name: string; group: string; key: string }[] = [
  { name: "Collection Centre Share", group: "Direct Expenses", key: "partner_share" },
  { name: "Recoveries from Partners", group: "Indirect Incomes", key: "partner_recoveries" },
  { name: "TDS Payable", group: "Duties & Taxes", key: "tds_payable" },
  { name: "Cash Short / Excess", group: "Indirect Expenses", key: "cash_short_excess" },
  { name: "Bank Charges", group: "Indirect Expenses", key: "bank_charges" },
  { name: "Profit & Loss A/c", group: "Reserves & Surplus", key: "retained_earnings" },
];

/** db-kit's chart of accounts plus FINANCE_LEDGERS. Idempotent. */
export async function seedFinanceLedgers(repos: Repositories, orgId: Id): Promise<Ledger[]> {
  const { groups } = await seedChartOfAccounts(repos, orgId);
  const byName = new Map(groups.map((g) => [g.name, g]));
  return repos.transaction(async (tx) => {
    for (const l of FINANCE_LEDGERS) {
      if (await tx.ledgers.findBySystemKey(orgId, l.key)) continue;
      await tx.ledgers.create({ orgId, name: l.name, groupId: byName.get(l.group)!.id, openingPaise: 0, systemKey: l.key, active: true });
    }
    return tx.ledgers.find({ orgId });
  });
}

/** A party's own ledger (a B2B customer under Sundry Debtors, a partner under Sundry Creditors). */
export async function createPartyLedger(tx: Repositories, orgId: Id, name: string, group: "Sundry Debtors" | "Sundry Creditors"): Promise<Ledger> {
  const g = await tx.accountGroups.findOne({ orgId, name: group });
  if (!g) throw new ValidationError("Seed the chart of accounts first (seedFinanceLedgers)");
  return tx.ledgers.create({ orgId, name, groupId: g.id, openingPaise: 0, systemKey: null, active: true });
}

/** Ledger id by db-kit / finance system key. */
export async function ledgerId(repos: Repositories, orgId: Id, key: string): Promise<Id> {
  const l = await repos.ledgers.findBySystemKey(orgId, key);
  if (!l) throw new NotFoundError("Ledger with systemKey", `${key} (run seedFinanceLedgers)`);
  return l.id;
}

export async function ledgerIds<K extends string>(repos: Repositories, orgId: Id, keys: readonly K[]): Promise<Record<K, Id>> {
  const out = {} as Record<K, Id>;
  for (const k of keys) out[k] = await ledgerId(repos, orgId, k);
  return out;
}

/** The ledger a payment mode lands in (same mapping as db-kit's default posting). */
export const MODE_LEDGER: Record<PaymentMode, string> = {
  cash: "cash", upi: "upi", wallet: "upi", card: "card", netbanking: "bank", cheque: "bank", insurance: "bank",
};

/** Balance (+Dr) of a ledger, optionally one branch's postings only, up to an instant. */
export const balanceOf = (repos: Repositories, q: { orgId: Id; ledgerId: Id; branchId?: Id; asOf?: Date }) => ledgerBalance(repos, q);

// ------------------------------------------------------------------ posting

export interface PostInput {
  orgId: Id;
  branchId: Id;
  type: VoucherType;
  date: Date;
  narration?: string;
  entries: VoucherEntry[];
  invoiceId?: Id | null;
  paymentId?: Id | null;
}

/** One signed line: positive = debit, negative = credit, zero = dropped. */
export const line = (ledgerId: Id, signedPaise: number, invoiceId?: Id | null): VoucherEntry =>
  signedPaise >= 0 ? { ledgerId, debitPaise: signedPaise, creditPaise: 0, invoiceId: invoiceId ?? null } : { ledgerId, debitPaise: 0, creditPaise: -signedPaise, invoiceId: invoiceId ?? null };

/** Posts a balanced voucher (numbered, refused in a locked period). */
export function post(repos: Repositories, input: PostInput, actorId?: Id): Promise<Voucher> {
  return postVoucher(repos, input, actorId);
}

/** Cancels a voucher (refused in a locked period). */
export function cancel(repos: Repositories, voucherId: Id, actorId?: Id): Promise<Voucher> {
  return cancelVoucher(repos, voucherId, actorId);
}

// ------------------------------------------------------------------ the posting hook for db-kit's billing

/** The receivable ledger of an invoice: its B2B customer's, else Patient Receivables. */
export async function receivableLedger(tx: Repositories, invoice: Pick<Invoice, "orgId" | "customerId">): Promise<Id> {
  if (invoice.customerId) {
    const c = await tx.customers.get(invoice.customerId);
    if (!c || c.orgId !== invoice.orgId) throw new NotFoundError("Customer", invoice.customerId);
    return c.ledgerId;
  }
  return ledgerId(tx, invoice.orgId, "receivables");
}

/** Sales voucher lines: tax split per line by place of supply; B2B invoices debit the customer's ledger. */
export async function salesEntries(tx: Repositories, invoice: Invoice): Promise<VoucherEntry[]> {
  const k = await ledgerIds(tx, invoice.orgId, ["sales", "discount", "round_off", "cgst", "sgst", "igst"] as const);
  const supply = await supplyResolver(tx)(invoice);
  const tax = invoiceTaxLines(invoice, supply.interState);
  const sum = (f: (l: (typeof tax)[number]) => number) => tax.reduce((s, l) => s + f(l), 0);
  const gross = invoice.items.reduce((s, i) => s + i.amountPaise + i.discountPaise, 0);
  if (sum((l) => l.taxPaise) !== invoice.taxPaise) throw new ValidationError(`Invoice ${invoice.invoiceNo}: line taxes do not add up to its tax`);
  return [
    line(await receivableLedger(tx, invoice), invoice.totalPaise, invoice.id),
    line(k.discount, invoice.discountPaise),
    line(k.sales, -gross),
    line(k.cgst, -sum((l) => l.cgstPaise)),
    line(k.sgst, -sum((l) => l.sgstPaise)),
    line(k.igst, -sum((l) => l.igstPaise)),
    line(k.round_off, -invoice.roundOffPaise),
  ].filter((e) => e.debitPaise > 0 || e.creditPaise > 0);
}

/**
 * Pass to db-kit: `createDb({ ..., posting: financePosting })`. Invoices, payments and cancellations
 * then post through this module: GST split by place of supply, and B2B customers' own ledgers.
 * Needs the chart of accounts (seedFinanceLedgers).
 */
export const financePosting: PostingHook = {
  async invoiceIssued(tx, invoice, actorId) {
    await post(tx, {
      orgId: invoice.orgId, branchId: invoice.branchId, type: "sales", date: invoice.issuedAt ?? new Date(),
      narration: `Invoice ${invoice.invoiceNo}`, entries: await salesEntries(tx, invoice), invoiceId: invoice.id,
    }, actorId);
  },
  async paymentRecorded(tx, payment: Payment, invoiceNo, actorId) {
    const invoice = await tx.invoices.get(payment.invoiceId);
    if (!invoice) throw new NotFoundError("Invoice", payment.invoiceId);
    const money = await ledgerId(tx, payment.orgId, MODE_LEDGER[payment.mode]);
    const recv = await receivableLedger(tx, invoice);
    const sign = payment.kind === "refund" ? -1 : 1;
    await post(tx, {
      orgId: payment.orgId, branchId: payment.branchId, type: payment.kind === "refund" ? "payment" : "receipt", date: payment.receivedAt,
      narration: `${payment.kind === "refund" ? "Refund" : "Payment"} ${payment.mode.toUpperCase()} against ${invoiceNo}`,
      entries: [line(money, sign * payment.amountPaise), line(recv, -sign * payment.amountPaise, payment.invoiceId)],
      invoiceId: payment.invoiceId, paymentId: payment.id,
    }, actorId);
  },
  async invoiceCancelled(tx, invoiceId, actorId) {
    for (const v of await tx.vouchers.find({ invoiceId, type: "sales", status: "posted" })) await cancel(tx, v.id, actorId);
  },
};

/** finance-kit's workflows need its posting hook on the repositories. */
export function assertFinancePosting(repos: Repositories): void {
  if (repos.posting !== financePosting)
    throw new ValidationError("finance-kit needs its posting hook: createDb({ ..., posting: financePosting })");
}
