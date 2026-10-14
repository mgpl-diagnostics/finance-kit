import {
  ConflictError, NotFoundError, ValidationError, type Address, type AgreementKind, type Id, type ItemCategory, type Partner, type PartnerAgreement,
  type PartnerKind, type Repositories,
} from "@mgpl-diagnostics/db-kit";
import { isValidGstin, stateOfGstin } from "../gst/place";
import { createPartyLedger } from "../posting";
import { endOfIstDay, startOfIstDay } from "../util";

/**
 * Collection centres and franchises: business partners paid a share of what their tests bill.
 * Not for doctors: referral payments to doctors are not built, on purpose (medical ethics rules).
 */

export interface PartnerInput {
  orgId: Id;
  code: string;
  name: string;
  kind: PartnerKind;
  /** The branch whose invoices earn this partner a share. */
  branchId: Id;
  legalName?: string;
  pan?: string;
  gstin?: string;
  stateCode?: string;
  phone?: string;
  email?: string;
  address?: Address;
  /** Overrides the default TDS section / rate (e.g. a lower-deduction certificate). Verify with CA. */
  tds?: { section: string; rateBp: number } | null;
}

const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;

function checkPartner(p: Partial<PartnerInput>) {
  if (p.pan !== undefined && p.pan !== "" && !PAN_RE.test(p.pan.toUpperCase())) throw new ValidationError(`Invalid PAN "${p.pan}"`);
  if (p.gstin !== undefined && p.gstin !== "" && !isValidGstin(p.gstin)) throw new ValidationError(`Invalid GSTIN "${p.gstin}"`);
  if (p.tds && !(Number.isInteger(p.tds.rateBp) && p.tds.rateBp >= 0 && p.tds.rateBp <= 10000 && p.tds.section.trim())) throw new ValidationError("TDS override needs a section and a rate of 0–10000 bp");
}

/** Creates a partner with its own payable ledger under Sundry Creditors. */
export async function createPartner(repos: Repositories, input: PartnerInput, actorId?: Id): Promise<Partner> {
  checkPartner(input);
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,32}$/.test(code)) throw new ValidationError(`Partner code must be 2–32 letters, digits, - or _: "${input.code}"`);
  return repos.transaction(async (tx) => {
    const branch = await tx.branches.get(input.branchId);
    if (!branch || branch.orgId !== input.orgId) throw new NotFoundError("Branch", input.branchId);
    if (await tx.partners.findOne({ orgId: input.orgId, code })) throw new ConflictError(`Partner ${code} already exists`);
    const ledger = await createPartyLedger(tx, input.orgId, `${input.name} [${code}] share payable`, "Sundry Creditors");
    const gstin = input.gstin ? input.gstin.toUpperCase() : undefined;
    const partner = await tx.partners.create({
      ...input, code, pan: input.pan?.toUpperCase(), gstin, stateCode: input.stateCode ?? stateOfGstin(gstin), ledgerId: ledger.id, tds: input.tds ?? null, active: true,
    });
    await tx.audit.log({ orgId: input.orgId, userId: actorId ?? null, action: "finance.partner.create", entity: "partner", entityId: partner.id, data: { code } });
    return partner;
  });
}

export type PartnerUpdate = { orgId: Id; partnerId: Id } & Partial<Omit<PartnerInput, "orgId" | "code" | "branchId">> & { active?: boolean };

/** Changes details or TDS settings. The code, branch and ledger stay. */
export async function updatePartner(repos: Repositories, input: PartnerUpdate, actorId?: Id): Promise<Partner> {
  const { orgId, partnerId, ...patch } = input;
  checkPartner(patch);
  const p = await repos.partners.get(partnerId);
  if (!p || p.orgId !== orgId) throw new NotFoundError("Partner", partnerId);
  const out = (await repos.partners.update(partnerId, { ...patch, ...(patch.pan ? { pan: patch.pan.toUpperCase() } : {}) }))!;
  await repos.audit.log({ orgId, userId: actorId ?? null, action: "finance.partner.update", entity: "partner", entityId: partnerId, data: { fields: Object.keys(patch) } });
  return out;
}

export interface AgreementInput {
  orgId: Id;
  partnerId: Id;
  kind: AgreementKind;
  /** revenue_share: basis points of the net billed value (2500 = 25%). */
  shareBp?: number;
  /** fixed_rate: amount per unit by item code. */
  rates?: { code: string; sharePaise: number }[];
  defaultSharePaise?: number;
  /** Default: test, package. */
  categories?: ItemCategory[];
  /** IST day the agreement starts. */
  effectiveFrom: string;
  /** IST day it ends (inclusive); omit for open-ended. */
  effectiveTo?: string;
  notes?: string;
}

/**
 * Adds an effective-dated agreement. A partner's agreements may not overlap: to change terms, end
 * the current one (`endAgreement`) the day before the new one starts, or add the new one and the open
 * one is ended automatically.
 */
export async function addAgreement(repos: Repositories, input: AgreementInput, actorId?: Id): Promise<PartnerAgreement> {
  if (input.kind === "revenue_share") {
    if (!(Number.isInteger(input.shareBp) && input.shareBp! >= 0 && input.shareBp! <= 10000)) throw new ValidationError("revenue_share needs shareBp of 0–10000");
  } else {
    if (!input.rates?.length && input.defaultSharePaise == null) throw new ValidationError("fixed_rate needs rates or defaultSharePaise");
    for (const r of input.rates ?? []) if (!(Number.isSafeInteger(r.sharePaise) && r.sharePaise >= 0)) throw new ValidationError(`Rate for ${r.code} must be whole paise ≥ 0`);
    if (new Set((input.rates ?? []).map((r) => r.code)).size !== (input.rates ?? []).length) throw new ValidationError("Duplicate item code in rates");
  }
  const from = startOfIstDay(input.effectiveFrom);
  const to = input.effectiveTo ? endOfIstDay(input.effectiveTo) : null;
  if (to && to.getTime() < from.getTime()) throw new ValidationError("effectiveTo is before effectiveFrom");
  return repos.transaction(async (tx) => {
    const partner = await tx.partners.get(input.partnerId);
    if (!partner || partner.orgId !== input.orgId) throw new NotFoundError("Partner", input.partnerId);
    for (const a of await tx.partnerAgreements.find({ partnerId: partner.id })) {
      const aEnd = a.effectiveTo?.getTime() ?? Infinity;
      if (!a.effectiveTo && a.effectiveFrom.getTime() < from.getTime()) {
        // the open agreement ends the moment before the new one starts
        await tx.partnerAgreements.update(a.id, { effectiveTo: new Date(from.getTime() - 1) });
        continue;
      }
      if (a.effectiveFrom.getTime() <= (to?.getTime() ?? Infinity) && from.getTime() <= aEnd) throw new ConflictError("Agreements of a partner may not overlap");
    }
    const ag = await tx.partnerAgreements.create({
      orgId: input.orgId, partnerId: partner.id, kind: input.kind, shareBp: input.kind === "revenue_share" ? input.shareBp! : null,
      rates: input.kind === "fixed_rate" ? input.rates ?? [] : [], defaultSharePaise: input.kind === "fixed_rate" ? input.defaultSharePaise ?? null : null,
      categories: input.categories, effectiveFrom: from, effectiveTo: to, notes: input.notes,
    });
    await tx.audit.log({ orgId: input.orgId, userId: actorId ?? null, action: "finance.agreement.add", entity: "partner_agreement", entityId: ag.id, data: { partnerId: partner.id, kind: input.kind } });
    return ag;
  });
}

/** The agreement in force at an instant (latest start wins). */
export function agreementOn(agreements: PartnerAgreement[], at: Date): PartnerAgreement | undefined {
  return agreements
    .filter((a) => a.effectiveFrom.getTime() <= at.getTime() && (!a.effectiveTo || at.getTime() <= a.effectiveTo.getTime()))
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];
}
