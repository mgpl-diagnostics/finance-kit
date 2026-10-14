import { ValidationError, type Branch, type Customer, type Organization } from "@mgpl-diagnostics/db-kit";

/** GSTIN format: 2-digit state code, PAN, entity number, "Z", check character. */
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export const isValidGstin = (gstin: string): boolean => GSTIN_RE.test(gstin.trim().toUpperCase());

/** The 2-digit state code at the start of a GSTIN. */
export function stateOfGstin(gstin: string | null | undefined): string | undefined {
  const g = gstin?.trim().toUpperCase();
  return g && /^\d{2}/.test(g) ? g.slice(0, 2) : undefined;
}

/** State code a branch supplies from: its stateCode, else its GSTIN, else the organisation's GSTIN. */
export function branchState(branch: Pick<Branch, "stateCode" | "gstin">, org?: Pick<Organization, "gstin"> | null): string {
  const s = branch.stateCode ?? stateOfGstin(branch.gstin) ?? stateOfGstin(org?.gstin);
  if (!s) throw new ValidationError("The branch has no GST state: set branch.stateCode or a GSTIN");
  return s;
}

/** GSTIN a branch's invoices are reported under: its own, else the organisation's. */
export const branchGstin = (branch: Pick<Branch, "gstin">, org?: Pick<Organization, "gstin"> | null): string | undefined =>
  branch.gstin?.toUpperCase() ?? org?.gstin?.toUpperCase();

/**
 * Place of supply (verify with CA): an explicit value wins; a B2B customer with a GSTIN or a state
 * code → the customer's state; otherwise the supplying branch's state.
 */
export function placeOfSupply(input: { branch: Pick<Branch, "stateCode" | "gstin">; org?: Pick<Organization, "gstin"> | null; customer?: Pick<Customer, "stateCode" | "gstin"> | null; override?: string | null }): string {
  if (input.override) return input.override;
  const c = input.customer && (input.customer.stateCode ?? stateOfGstin(input.customer.gstin));
  return c ?? branchState(input.branch, input.org);
}
