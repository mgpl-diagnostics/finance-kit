import type { Repositories, Taxability } from "@mgpl-diagnostics/db-kit";
import { VERIFY_WITH_CA } from "../config";
import { addTotals, load, zero, type ReturnQuery } from "./source";
import type { Supply } from "./supply";

/**
 * GSTR-3B outward supplies (table 3.1 a, c, e) and inter-state supplies to unregistered persons by
 * place of supply (table 3.2), net of credit notes. Inward supplies and ITC come with payables (Phase 2).
 */
export async function gstr3b(repos: Repositories, q: ReturnQuery) {
  const { gstin, invoices, notes } = await load(repos, q);
  const taxable = zero();
  let nilExempt = 0;
  let nonGst = 0;
  const unreg = new Map<string, { placeOfSupply: string; taxablePaise: number; igstPaise: number }>();
  const add = (supply: Supply, registered: boolean, l: { taxability?: Taxability; taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number }, sign: number) => {
    const t = l.taxability ?? "exempt";
    if (t === "taxable") {
      addTotals(taxable, l, sign);
      if (supply.interState && !registered) {
        const r = unreg.get(supply.placeOfSupply) ?? { placeOfSupply: supply.placeOfSupply, taxablePaise: 0, igstPaise: 0 };
        r.taxablePaise += sign * l.taxablePaise;
        r.igstPaise += sign * l.igstPaise;
        unreg.set(supply.placeOfSupply, r);
      }
    } else if (t === "non_gst") nonGst += sign * l.taxablePaise;
    else nilExempt += sign * l.taxablePaise;
  };
  for (const { inv, supply, lines } of invoices) for (const l of lines) add(supply, Boolean(inv.buyerGstin), l, 1);
  for (const { note, supply } of notes) for (const l of note.lines) add(supply, Boolean(note.buyerGstin), l, -1);
  return {
    gstin,
    period: { from: q.from, to: q.to },
    /** 3.1(a) outward taxable supplies (other than zero-rated, nil-rated and exempted). */
    outwardTaxable: taxable,
    /** 3.1(c) other outward supplies (nil-rated, exempted). */
    outwardNilExemptPaise: nilExempt,
    /** 3.1(e) non-GST outward supplies. */
    outwardNonGstPaise: nonGst,
    /** 3.2 inter-state supplies to unregistered persons, by place of supply. */
    interStateUnregistered: [...unreg.values()].sort((a, b) => a.placeOfSupply.localeCompare(b.placeOfSupply)),
    verifyWithCA: VERIFY_WITH_CA,
  };
}

export type Gstr3b = Awaited<ReturnType<typeof gstr3b>>;
