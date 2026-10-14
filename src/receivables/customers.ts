import {
  computeTotals, ConflictError, issueInvoice, NotFoundError, ValidationError, type Address, type Customer, type CustomerKind, type Id, type Invoice,
  type IssueInvoiceInput, type Payment, type Repositories,
} from "@mgpl-diagnostics/db-kit";
import { isValidGstin, placeOfSupply, stateOfGstin } from "../gst/place";
import { applyTaxRules } from "../gst/rules";
import { assertFinancePosting, balanceOf, createPartyLedger, ledgerStatement } from "../posting";
import { addDays, daysBetween, istDay } from "../util";

export interface CustomerInput {
  orgId: Id;
  code: string;
  name: string;
  kind: CustomerKind;
  legalName?: string;
  gstin?: string;
  stateCode?: string;
  pan?: string;
  phone?: string;
  email?: string;
  address?: Address;
  /** null or omitted = no limit. */
  creditLimitPaise?: number | null;
  creditDays?: number;
}

/** Thrown when a B2B invoice would take a customer over its credit limit. */
export class CreditLimitError extends ConflictError {
  constructor(customer: Customer, outstanding: number, amount: number) {
    super(`Credit limit of ${customer.code} exceeded: outstanding ${outstanding} + ${amount} > ${customer.creditLimitPaise} paise`);
    this.name = "CreditLimitError";
  }
}

function checkCustomer(c: Partial<CustomerInput>): void {
  if (c.gstin !== undefined && c.gstin !== "" && !isValidGstin(c.gstin)) throw new ValidationError(`Invalid GSTIN "${c.gstin}"`);
  if (c.stateCode !== undefined && !/^\d{2}$/.test(c.stateCode)) throw new ValidationError(`State code must be 2 digits: "${c.stateCode}"`);
  if (c.creditLimitPaise != null && !(Number.isSafeInteger(c.creditLimitPaise) && c.creditLimitPaise >= 0)) throw new ValidationError("creditLimitPaise must be whole paise ≥ 0");
  if (c.creditDays !== undefined && !(Number.isInteger(c.creditDays) && c.creditDays >= 0)) throw new ValidationError("creditDays must be a whole number ≥ 0");
}

/** Creates a B2B customer with its own ledger under Sundry Debtors. */
export async function createCustomer(repos: Repositories, input: CustomerInput, actorId?: Id): Promise<Customer> {
  checkCustomer(input);
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,32}$/.test(code)) throw new ValidationError(`Customer code must be 2–32 letters, digits, - or _: "${input.code}"`);
  return repos.transaction(async (tx) => {
    if (await tx.customers.findOne({ orgId: input.orgId, code })) throw new ConflictError(`Customer ${code} already exists`);
    const gstin = input.gstin ? input.gstin.trim().toUpperCase() : undefined;
    const ledger = await createPartyLedger(tx, input.orgId, `${input.name} [${code}]`, "Sundry Debtors");
    const customer = await tx.customers.create({
      ...input, code, gstin, stateCode: input.stateCode ?? stateOfGstin(gstin), creditLimitPaise: input.creditLimitPaise ?? null,
      creditDays: input.creditDays ?? 0, ledgerId: ledger.id, active: true,
    });
    await tx.audit.log({ orgId: input.orgId, userId: actorId ?? null, action: "finance.customer.create", entity: "customer", entityId: customer.id, data: { code } });
    return customer;
  });
}

export type CustomerUpdate = { orgId: Id; customerId: Id } & Partial<Omit<CustomerInput, "orgId" | "code">> & { active?: boolean };

/** Changes terms or details. The code and ledger stay. */
export async function updateCustomer(repos: Repositories, input: CustomerUpdate, actorId?: Id): Promise<Customer> {
  const { orgId, customerId, ...patch } = input;
  checkCustomer(patch);
  return repos.transaction(async (tx) => {
    const c = await tx.customers.getForUpdate(customerId);
    if (!c || c.orgId !== orgId) throw new NotFoundError("Customer", customerId);
    const gstin = patch.gstin ? patch.gstin.trim().toUpperCase() : patch.gstin;
    const out = (await tx.customers.update(customerId, { ...patch, ...(gstin !== undefined ? { gstin, stateCode: patch.stateCode ?? stateOfGstin(gstin) } : {}) }))!;
    await tx.audit.log({ orgId, userId: actorId ?? null, action: "finance.customer.update", entity: "customer", entityId: customerId, data: { fields: Object.keys(patch) } });
    return out;
  });
}

export interface CustomerInvoiceInput extends Omit<IssueInvoiceInput, "customerId" | "placeOfSupply" | "buyerGstin"> {
  customerId: Id;
  /** Overrides the place of supply (state code). */
  placeOfSupply?: string;
  /** Fill GST from the tax rules (default true). */
  applyTaxRules?: boolean;
}

/**
 * Issues a B2B invoice: locks the customer, applies the GST rules, checks the credit limit against
 * the customer's ledger balance, and bills through db-kit's issueInvoice, all in one transaction.
 */
export async function issueCustomerInvoice(repos: Repositories, input: CustomerInvoiceInput, actorId?: Id): Promise<{ invoice: Invoice; payments: Payment[] }> {
  assertFinancePosting(repos);
  const date = input.date ?? new Date();
  return repos.transaction(async (tx) => {
    const customer = await tx.customers.getForUpdate(input.customerId);
    if (!customer || customer.orgId !== input.orgId) throw new NotFoundError("Customer", input.customerId);
    if (!customer.active) throw new ConflictError(`Customer ${customer.code} is inactive`);
    const [branch, org] = await Promise.all([tx.branches.get(input.branchId), tx.orgs.get(input.orgId)]);
    if (!branch || branch.orgId !== input.orgId) throw new NotFoundError("Branch", input.branchId);
    const items = input.applyTaxRules === false ? input.items : await applyTaxRules(tx, input.orgId, input.items, date);
    const { totals } = computeTotals(items, input.billDiscountPaise);
    const paidNow = (input.payments ?? []).reduce((s, p) => s + p.amountPaise, 0);
    if (customer.creditLimitPaise !== null) {
      const outstanding = await balanceOf(tx, { orgId: input.orgId, ledgerId: customer.ledgerId });
      if (outstanding + totals.totalPaise - paidNow > customer.creditLimitPaise) throw new CreditLimitError(customer, outstanding, totals.totalPaise - paidNow);
    }
    const { applyTaxRules: _skip, ...rest } = input;
    return issueInvoice(tx, {
      ...rest, items, date, customerId: customer.id, buyerGstin: customer.gstin ?? null,
      placeOfSupply: placeOfSupply({ branch, org, customer, override: input.placeOfSupply }),
    }, actorId);
  });
}

// ------------------------------------------------------------------ statements

export type AgeBucket = "not_due" | "1-30" | "31-60" | "61-90" | "90+";

export interface OpenItem {
  invoiceId: Id;
  invoiceNo: string;
  day: string;
  dueDay: string;
  totalPaise: number;
  paidPaise: number;
  creditedPaise: number;
  duePaise: number;
  /** Days past the due date (0 when not yet due). */
  overdueDays: number;
  bucket: AgeBucket;
}

const bucketOf = (overdue: number): AgeBucket => (overdue <= 0 ? "not_due" : overdue <= 30 ? "1-30" : overdue <= 60 ? "31-60" : overdue <= 90 ? "61-90" : "90+");

/**
 * A customer's statement for a period: opening balance, every posting with a running balance, closing
 * balance (from its ledger), plus open invoices aged by days past their due date at `to`.
 */
export async function customerStatement(repos: Repositories, q: { orgId: Id; customerId: Id; from: Date; to: Date }) {
  const customer = await repos.customers.get(q.customerId);
  if (!customer || customer.orgId !== q.orgId) throw new NotFoundError("Customer", q.customerId);
  const statement = await ledgerStatement(repos, { orgId: q.orgId, ledgerId: customer.ledgerId, from: q.from, to: q.to });
  const asOfDay = istDay(q.to);
  const invoices = await repos.invoices.listByDate({ orgId: q.orgId, customerId: customer.id, to: q.to });
  const open: OpenItem[] = invoices.filter((i) => i.duePaise > 0).map((i) => {
    const day = istDay(i.issuedAt ?? i.createdAt);
    const dueDay = addDays(day, customer.creditDays);
    const overdue = Math.max(0, daysBetween(dueDay, asOfDay));
    return {
      invoiceId: i.id, invoiceNo: i.invoiceNo, day, dueDay, totalPaise: i.totalPaise, paidPaise: i.paidPaise, creditedPaise: i.creditedPaise ?? 0,
      duePaise: i.duePaise, overdueDays: overdue, bucket: bucketOf(overdue),
    };
  });
  const ageing: Record<AgeBucket, number> = { not_due: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  for (const o of open) ageing[o.bucket] += o.duePaise;
  const limit = customer.creditLimitPaise;
  return {
    customer,
    openingPaise: statement.openingPaise,
    rows: statement.rows,
    totalDebitPaise: statement.totalDebitPaise,
    totalCreditPaise: statement.totalCreditPaise,
    closingPaise: statement.closingPaise,
    open,
    ageing,
    openTotalPaise: open.reduce((s, o) => s + o.duePaise, 0),
    availableCreditPaise: limit === null ? null : limit - statement.closingPaise,
  };
}

/** Every customer's balance, overdue amount and ageing at an instant. */
export async function receivablesSummary(repos: Repositories, q: { orgId: Id; asOf: Date }) {
  const rows = [];
  for (const c of await repos.customers.find({ orgId: q.orgId }, { sort: { field: "code" } })) {
    const s = await customerStatement(repos, { orgId: q.orgId, customerId: c.id, from: q.asOf, to: q.asOf });
    rows.push({ customer: c, balancePaise: s.closingPaise, overduePaise: s.openTotalPaise - s.ageing.not_due, ageing: s.ageing });
  }
  return { rows, totalPaise: rows.reduce((s, r) => s + r.balancePaise, 0) };
}
