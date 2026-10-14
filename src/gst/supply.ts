import { NotFoundError, type Branch, type Invoice, type Organization, type Repositories } from "@mgpl-diagnostics/db-kit";
import { branchGstin, branchState } from "./place";

export interface Supply {
  branch: Branch;
  /** GSTIN the invoice is reported under. */
  gstin?: string;
  branchState: string;
  placeOfSupply: string;
  interState: boolean;
}

/** Looks up branches and the organisation once per report. */
export function supplyResolver(repos: Repositories) {
  const branches = new Map<string, Promise<Branch | null>>();
  const orgs = new Map<string, Promise<Organization | null>>();
  return async (invoice: Pick<Invoice, "orgId" | "branchId" | "placeOfSupply">): Promise<Supply> => {
    if (!branches.has(invoice.branchId)) branches.set(invoice.branchId, repos.branches.get(invoice.branchId));
    if (!orgs.has(invoice.orgId)) orgs.set(invoice.orgId, repos.orgs.get(invoice.orgId));
    const branch = await branches.get(invoice.branchId)!;
    if (!branch) throw new NotFoundError("Branch", invoice.branchId);
    const org = await orgs.get(invoice.orgId)!;
    const from = branchState(branch, org);
    const pos = invoice.placeOfSupply ?? from;
    return { branch, gstin: branchGstin(branch, org), branchState: from, placeOfSupply: pos, interState: pos !== from };
  };
}
