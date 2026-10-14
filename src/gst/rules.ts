import { ValidationError, type Id, type ItemCategory, type ItemInput, type Repositories, type TaxRule } from "@mgpl-diagnostics/db-kit";
import { DEFAULT_TAX_RULES, type TaxRuleDef } from "../config";
import { startOfIstDay } from "../util";

/**
 * GST rules are data. A rule says which SAC/HSN, taxability and rate apply to one item code or a whole
 * category from a date. The defaults must be confirmed by the lab's CA (see docs/gst-notes.md).
 */

const VALID_RATES = new Set([0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40]);

export function validateRule(r: Pick<TaxRule, "code" | "category" | "hsnSac" | "taxability" | "ratePercent">): void {
  if (!r.code && !r.category) throw new ValidationError("A tax rule needs an item code or a category");
  if (!/^\d{4,8}$/.test(r.hsnSac)) throw new ValidationError(`SAC/HSN must be 4–8 digits: "${r.hsnSac}"`);
  if (!VALID_RATES.has(r.ratePercent)) throw new ValidationError(`Unknown GST rate ${r.ratePercent}%`);
  if (r.taxability === "taxable" ? r.ratePercent <= 0 : r.ratePercent !== 0) throw new ValidationError("Only taxable rules carry a rate above 0");
}

/** Adds a rule (validated). Rules are effective-dated: add a new one rather than editing an old one. */
export async function addTaxRule(repos: Repositories, orgId: Id, def: TaxRuleDef, actorId?: Id): Promise<TaxRule> {
  const rule = { code: def.code ?? null, category: def.category ?? null, hsnSac: def.hsnSac, taxability: def.taxability, ratePercent: def.ratePercent };
  validateRule(rule);
  const created = await repos.taxRules.create({ orgId, ...rule, effectiveFrom: startOfIstDay(def.effectiveFrom), effectiveTo: null, note: def.note });
  await repos.audit.log({ orgId, userId: actorId ?? null, action: "finance.tax_rule.add", entity: "tax_rule", entityId: created.id, data: { ...rule } });
  return created;
}

/** Seeds DEFAULT_TAX_RULES (or the given ones) when the organisation has no rules yet. */
export async function seedTaxRules(repos: Repositories, orgId: Id, defs: TaxRuleDef[] = DEFAULT_TAX_RULES, actorId?: Id): Promise<TaxRule[]> {
  if ((await repos.taxRules.count({ orgId })) > 0) return repos.taxRules.find({ orgId });
  return repos.transaction(async (tx) => {
    const out: TaxRule[] = [];
    for (const d of defs) out.push(await addTaxRule(tx, orgId, d, actorId));
    return out;
  });
}

const activeOn = (r: TaxRule, at: Date) => r.effectiveFrom.getTime() <= at.getTime() && (!r.effectiveTo || at.getTime() <= r.effectiveTo.getTime());

/**
 * The rule for an item on a date: a rule for its code beats a rule for its category; among those, the
 * latest effectiveFrom wins. undefined when nothing applies.
 */
export function resolveTaxRule(rules: TaxRule[], item: { code?: string; category?: ItemCategory }, at: Date): TaxRule | undefined {
  const pick = (xs: TaxRule[]) => xs.filter((r) => activeOn(r, at)).sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];
  return (item.code ? pick(rules.filter((r) => r.code === item.code)) : undefined) ?? pick(rules.filter((r) => !r.code && r.category === (item.category ?? "test")));
}

/**
 * Fills taxPercent, hsnSac and taxability on invoice items from the organisation's rules, for db-kit's
 * issueInvoice. Throws ValidationError for an item no rule covers: the CA must classify it first.
 */
export async function applyTaxRules(repos: Repositories, orgId: Id, items: ItemInput[], at: Date = new Date()): Promise<ItemInput[]> {
  const rules = await repos.taxRules.find({ orgId });
  return items.map((i) => {
    const rule = resolveTaxRule(rules, i, at);
    if (!rule) throw new ValidationError(`No GST rule for ${i.code ? `item ${i.code}` : `"${i.name}"`} (${i.category ?? "test"}); add one (verify with CA)`);
    return { ...i, taxPercent: rule.ratePercent, hsnSac: rule.hsnSac, taxability: rule.taxability };
  });
}
