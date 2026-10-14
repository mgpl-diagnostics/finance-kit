import { billDiscountShares, type Invoice, type Taxability } from "@mgpl-diagnostics/db-kit";

/** One invoice line's GST: taxable value after line and bill discounts, and the tax split. */
export interface TaxLine {
  itemIndex: number;
  code?: string;
  name: string;
  category: Invoice["items"][number]["category"];
  hsnSac: string;
  taxability: Taxability;
  qty: number;
  ratePercent: number;
  taxablePaise: number;
  taxPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
}

/** A line's GST treatment: the stored one, else taxable when it carries tax, else exempt. */
export const taxabilityOf = (item: Invoice["items"][number]): Taxability => item.taxability ?? (item.taxPercent > 0 ? "taxable" : "exempt");

/** Splits tax into CGST + SGST (intra-state; CGST takes the lower half of an odd paisa) or IGST. */
export function splitTax(taxPaise: number, interState: boolean): { cgstPaise: number; sgstPaise: number; igstPaise: number } {
  if (interState) return { cgstPaise: 0, sgstPaise: 0, igstPaise: taxPaise };
  const cgst = Math.floor(taxPaise / 2);
  return { cgstPaise: cgst, sgstPaise: taxPaise - cgst, igstPaise: 0 };
}

/**
 * Per-line GST of an invoice, recomputed exactly the way db-kit billed it: the bill discount is shared
 * across lines with the largest-remainder rule, and each line's tax is rounded on its own. The line
 * taxes add up to `invoice.taxPaise`; the split is per line, so returns and postings agree to the paisa.
 */
export function invoiceTaxLines(invoice: Pick<Invoice, "items" | "discountPaise">, interState: boolean): TaxLine[] {
  const items = invoice.items;
  const billDiscount = invoice.discountPaise - items.reduce((s, i) => s + i.discountPaise, 0);
  const shares = billDiscountShares(items.map((i) => i.amountPaise), Math.max(0, billDiscount));
  return items.map((i, idx) => {
    const taxable = i.amountPaise - shares[idx]!;
    const tax = Math.round((taxable * i.taxPercent) / 100);
    return {
      itemIndex: idx, code: i.code, name: i.name, category: i.category, hsnSac: i.hsnSac ?? "", taxability: taxabilityOf(i), qty: i.qty,
      ratePercent: i.taxPercent, taxablePaise: taxable, taxPaise: tax, ...splitTax(tax, interState),
    };
  });
}

export interface RateTotals {
  ratePercent: number;
  taxablePaise: number;
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  cessPaise: number;
}

/** Taxable lines grouped by GST rate (the shape GSTR-1 uses for invoice items). */
export function byRate(lines: Pick<TaxLine, "ratePercent" | "taxablePaise" | "igstPaise" | "cgstPaise" | "sgstPaise" | "taxability">[]): RateTotals[] {
  const map = new Map<number, RateTotals>();
  for (const l of lines) {
    if (l.taxability !== "taxable") continue;
    const r = map.get(l.ratePercent) ?? { ratePercent: l.ratePercent, taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0, cessPaise: 0 };
    r.taxablePaise += l.taxablePaise;
    r.igstPaise += l.igstPaise;
    r.cgstPaise += l.cgstPaise;
    r.sgstPaise += l.sgstPaise;
    map.set(l.ratePercent, r);
  }
  return [...map.values()].sort((a, b) => a.ratePercent - b.ratePercent);
}
