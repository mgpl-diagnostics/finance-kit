import type { ItemCategory, Repositories, Taxability } from "@mgpl-diagnostics/db-kit";

/**
 * Compliance values are CONFIGURATION, not legal advice. Every value below marked "verify with CA"
 * must be confirmed by the lab's chartered accountant before use (see docs/gst-notes.md).
 * An organisation overrides them in `organization.settings.finance` (merged over these defaults).
 */

export interface TdsConfig {
  /** Section label printed on statements, e.g. "194H". Verify with CA. */
  section: string;
  /** Rate in basis points (200 = 2%). Verify with CA. */
  rateBp: number;
  /** Rate when the partner has no PAN on record, in basis points. Verify with CA. */
  noPanRateBp: number;
  /** TDS applies once a partner's shares in the financial year exceed this (null = always). Verify with CA. */
  thresholdPaise: number | null;
}

export interface FinanceConfig {
  gst: {
    /** GSTR-1 B2C Large: inter-state invoices to unregistered buyers above this value. Verify with CA. */
    b2clThresholdPaise: number;
  };
  /** Default TDS on partner shares; a partner's own `tds` overrides section and rate. */
  tds: TdsConfig;
  bank: {
    /** How far apart (days) a bank line and its book entry may be dated. */
    toleranceDays: number;
    /** Card / UPI settlements: the largest fee (MDR) accepted, in basis points of the gross. */
    maxFeeBp: number;
    /** Clearing ledgers settled into the bank net of fees (db-kit system keys). */
    clearingLedgerKeys: string[];
  };
}

export const DEFAULT_FINANCE_CONFIG: FinanceConfig = {
  gst: { b2clThresholdPaise: 100_000_00 },
  tds: { section: "194H", rateBp: 200, noPanRateBp: 2000, thresholdPaise: 20_000_00 },
  bank: { toleranceDays: 3, maxFeeBp: 300, clearingLedgerKeys: ["upi", "card"] },
};

/** The values the lab's CA must confirm. Shown in docs and returned with every GST/TDS report. */
export const VERIFY_WITH_CA = [
  "GST taxability, SAC/HSN and rates of every item category and code (tax rules)",
  "Place of supply for diagnostic services and goods (CGST+SGST vs IGST)",
  "GSTR-1 B2C Large threshold",
  "TDS section, rate, no-PAN rate, threshold and rounding on partner shares",
  "GST on partner shares (not charged in this version)",
] as const;

export interface TaxRuleDef {
  code?: string | null;
  category?: ItemCategory | null;
  hsnSac: string;
  taxability: Taxability;
  ratePercent: number;
  effectiveFrom: string;
  note?: string;
}

/**
 * Starting rules, seeded by seedTaxRules. Verify with CA.
 * Diagnostic services by a clinical establishment are generally exempt; consumables and medicines
 * have no category default on purpose: each item code needs its own HSN and rate rule, and
 * applyTaxRules refuses a code without one.
 */
export const DEFAULT_TAX_RULES: TaxRuleDef[] = [
  { category: "test", hsnSac: "999316", taxability: "exempt", ratePercent: 0, effectiveFrom: "2017-07-01", note: "Diagnostic services by a clinical establishment. Verify with CA." },
  { category: "package", hsnSac: "999316", taxability: "exempt", ratePercent: 0, effectiveFrom: "2017-07-01", note: "Health packages of diagnostic tests. Verify with CA." },
  { category: "service", hsnSac: "999316", taxability: "exempt", ratePercent: 0, effectiveFrom: "2017-07-01", note: "Home collection and other lab services. Verify with CA." },
];

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };
export type FinanceSettings = DeepPartial<FinanceConfig>;

export function mergeConfig(over: FinanceSettings = {}): FinanceConfig {
  const d = DEFAULT_FINANCE_CONFIG;
  return {
    gst: { ...d.gst, ...over.gst },
    tds: { ...d.tds, ...over.tds },
    bank: { ...d.bank, ...over.bank, clearingLedgerKeys: over.bank?.clearingLedgerKeys ?? d.bank.clearingLedgerKeys },
  } as FinanceConfig;
}

/** The organisation's finance configuration: `settings.finance` over the defaults. */
export async function financeConfig(repos: Repositories, orgId: string): Promise<FinanceConfig> {
  const org = await repos.orgs.get(orgId);
  return mergeConfig((org?.settings?.finance ?? {}) as FinanceSettings);
}
