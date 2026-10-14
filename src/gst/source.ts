import { ValidationError, type CreditNote, type Id, type Invoice, type Repositories } from "@mgpl-diagnostics/db-kit";
import { invoiceTaxLines, type RateTotals, type TaxLine } from "./breakup";
import { supplyResolver, type Supply } from "./supply";

/**
 * GSTR-1 and GSTR-3B data built from invoices and credit notes, as plain JSON in paise.
 * Our own shapes: the official GST portal JSON can be generated from them later (Phase 2).
 */

export interface ReturnQuery {
  orgId: Id;
  /** The GSTIN filed for (branches reporting under it). Default: the organisation's GSTIN. */
  gstin?: string;
  from: Date;
  to: Date;
}

export interface Totals {
  taxablePaise: number;
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  cessPaise: number;
}

export interface Doc {
  supply: Supply;
  registered: boolean;
  lines: TaxLine[] | CreditNote["lines"];
}

export function scope(repos: Repositories, q: ReturnQuery) {
  const resolve = supplyResolver(repos);
  let gstin = q.gstin?.toUpperCase();
  return {
    resolve,
    async gstinOf(): Promise<string> {
      if (!gstin) gstin = (await repos.orgs.get(q.orgId))?.gstin?.toUpperCase();
      if (!gstin) throw new ValidationError("No GSTIN: pass one or set the organisation's");
      return gstin;
    },
  };
}

export async function load(repos: Repositories, q: ReturnQuery) {
  const s = scope(repos, q);
  const gstin = await s.gstinOf();
  const all = await repos.invoices.listByDate({ orgId: q.orgId, from: q.from, to: q.to, includeCancelled: true });
  const invoices: { inv: Invoice; supply: Supply; lines: TaxLine[] }[] = [];
  const cancelled: Invoice[] = [];
  for (const inv of all) {
    const supply = await s.resolve(inv);
    if (supply.gstin !== gstin) continue;
    if (inv.status === "cancelled") cancelled.push(inv);
    else invoices.push({ inv, supply, lines: invoiceTaxLines(inv, supply.interState) });
  }
  const notesAll = await repos.creditNotes.listByDate({ orgId: q.orgId, from: q.from, to: q.to, includeCancelled: true });
  const originals = new Map((await repos.invoices.getMany([...new Set(notesAll.map((n) => n.invoiceId))])).map((i) => [i.id, i]));
  const notes: { note: CreditNote; supply: Supply; original: Invoice }[] = [];
  const cancelledNotes: CreditNote[] = [];
  for (const note of notesAll) {
    const original = originals.get(note.invoiceId)!;
    const supply = await s.resolve({ ...original, placeOfSupply: note.placeOfSupply ?? original.placeOfSupply });
    if (supply.gstin !== gstin) continue;
    if (note.status === "cancelled") cancelledNotes.push(note);
    else notes.push({ note, supply, original });
  }
  return { gstin, invoices, cancelled, notes, cancelledNotes };
}

export const neg = (r: RateTotals): RateTotals => ({ ...r, taxablePaise: -r.taxablePaise, igstPaise: -r.igstPaise, cgstPaise: -r.cgstPaise, sgstPaise: -r.sgstPaise, cessPaise: -r.cessPaise });
export const addTotals = (t: Totals, r: { taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; cessPaise?: number }, sign = 1) => {
  t.taxablePaise += sign * r.taxablePaise;
  t.igstPaise += sign * r.igstPaise;
  t.cgstPaise += sign * r.cgstPaise;
  t.sgstPaise += sign * r.sgstPaise;
  t.cessPaise += sign * (r.cessPaise ?? 0);
};
export const zero = (): Totals => ({ taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0, cessPaise: 0 });
export const series = (no: string) => no.slice(0, no.lastIndexOf("/") + 1);
