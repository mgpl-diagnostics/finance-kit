import type { Id, Invoice, Repositories, Taxability } from "@mgpl-diagnostics/db-kit";
import { financeConfig, VERIFY_WITH_CA } from "../config";
import { istDay } from "../util";
import { byRate, type RateTotals } from "./breakup";
import { addTotals, load, neg, series, zero, type Doc, type ReturnQuery, type Totals } from "./source";
import type { Supply } from "./supply";

export interface Gstr1Invoice {
  invoiceId: Id;
  invoiceNo: string;
  day: string;
  /** Invoice value incl. tax and round-off. */
  valuePaise: number;
  placeOfSupply: string;
  reverseCharge: "N";
  items: RateTotals[];
}

export interface Gstr1Note {
  noteId: Id;
  noteNo: string;
  day: string;
  noteType: "C";
  invoiceNo: string;
  invoiceDay: string;
  valuePaise: number;
  placeOfSupply: string;
  items: RateTotals[];
}

export interface B2csRow {
  supplyType: "INTRA" | "INTER";
  placeOfSupply: string;
  ratePercent: number;
  taxablePaise: number;
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  cessPaise: number;
}

export interface NilRow {
  description: "Inter-state supplies to registered persons" | "Intra-state supplies to registered persons" | "Inter-state supplies to unregistered persons" | "Intra-state supplies to unregistered persons";
  nilRatedPaise: number;
  exemptedPaise: number;
  nonGstPaise: number;
}

export interface HsnRow {
  hsnSac: string;
  ratePercent: number;
  taxability: Taxability;
  qty: number;
  taxablePaise: number;
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  cessPaise: number;
  /** taxable + tax */
  totalValuePaise: number;
}

export interface DocSeries {
  nature: "Invoices for outward supply" | "Credit Note";
  series: string;
  from: string;
  to: string;
  total: number;
  cancelled: number;
  net: number;
}


/**
 * GSTR-1 data for a period: B2B (invoice-wise), B2C Large, B2C Small (aggregated, net of their credit
 * notes), credit notes to registered (CDNR) and B2C Large buyers (CDNUR), nil / exempt / non-GST,
 * HSN/SAC summary (B2B and B2C), and the document summary.
 */
export async function gstr1(repos: Repositories, q: ReturnQuery) {
  const cfg = await financeConfig(repos, q.orgId);
  const { gstin, invoices, cancelled, notes, cancelledNotes } = await load(repos, q);
  const isB2cl = (inv: Invoice, supply: Supply) => !inv.buyerGstin && supply.interState && inv.totalPaise > cfg.gst.b2clThresholdPaise;

  const b2b: (Gstr1Invoice & { ctin: string })[] = [];
  const b2cl: Gstr1Invoice[] = [];
  const b2cs = new Map<string, B2csRow>();
  const cdnr: (Gstr1Note & { ctin: string })[] = [];
  const cdnur: (Gstr1Note & { type: "B2CL" })[] = [];
  const nil = new Map<NilRow["description"], NilRow>();
  const hsn = { b2b: new Map<string, HsnRow>(), b2c: new Map<string, HsnRow>() };

  const nilAdd = (d: Doc, l: { taxability?: Taxability; taxablePaise: number }, sign: number) => {
    const t = l.taxability ?? "exempt";
    if (t === "taxable") return;
    const desc = `${d.supply.interState ? "Inter" : "Intra"}-state supplies to ${d.registered ? "registered" : "unregistered"} persons` as NilRow["description"];
    const row = nil.get(desc) ?? { description: desc, nilRatedPaise: 0, exemptedPaise: 0, nonGstPaise: 0 };
    if (t === "nil_rated") row.nilRatedPaise += sign * l.taxablePaise;
    else if (t === "exempt") row.exemptedPaise += sign * l.taxablePaise;
    else row.nonGstPaise += sign * l.taxablePaise;
    nil.set(desc, row);
  };
  const hsnAdd = (d: Doc, l: { hsnSac?: string; taxability?: Taxability; taxPercent?: number; ratePercent?: number; qty?: number; taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number }, sign: number) => {
    const rate = l.ratePercent ?? l.taxPercent ?? 0;
    const code = l.hsnSac || "UNCLASSIFIED";
    const key = `${code}|${rate}|${l.taxability}`;
    const m = d.registered ? hsn.b2b : hsn.b2c;
    const row = m.get(key) ?? { hsnSac: code, ratePercent: rate, taxability: l.taxability ?? "exempt", qty: 0, taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0, cessPaise: 0, totalValuePaise: 0 };
    // a credit note reduces value, not quantity
    if (sign > 0) row.qty += l.qty ?? 0;
    row.taxablePaise += sign * l.taxablePaise;
    row.igstPaise += sign * l.igstPaise;
    row.cgstPaise += sign * l.cgstPaise;
    row.sgstPaise += sign * l.sgstPaise;
    row.totalValuePaise += sign * (l.taxablePaise + l.igstPaise + l.cgstPaise + l.sgstPaise);
    m.set(key, row);
  };
  const b2csAdd = (supply: Supply, items: RateTotals[]) => {
    for (const r of items) {
      const supplyType = supply.interState ? "INTER" : "INTRA";
      const key = `${supplyType}|${supply.placeOfSupply}|${r.ratePercent}`;
      const row = b2cs.get(key) ?? { supplyType, placeOfSupply: supply.placeOfSupply, ratePercent: r.ratePercent, taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0, cessPaise: 0 };
      addTotals(row, r);
      b2cs.set(key, row);
    }
  };

  for (const { inv, supply, lines } of invoices) {
    const d: Doc = { supply, registered: Boolean(inv.buyerGstin), lines };
    for (const l of lines) { nilAdd(d, l, 1); hsnAdd(d, l, 1); }
    const items = byRate(lines);
    if (!items.length) continue;
    const base = { invoiceId: inv.id, invoiceNo: inv.invoiceNo, day: istDay(inv.issuedAt ?? inv.createdAt), valuePaise: inv.totalPaise, placeOfSupply: supply.placeOfSupply, reverseCharge: "N" as const, items };
    if (inv.buyerGstin) b2b.push({ ctin: inv.buyerGstin, ...base });
    else if (isB2cl(inv, supply)) b2cl.push(base);
    else b2csAdd(supply, items);
  }
  for (const { note, supply, original } of notes) {
    const d: Doc = { supply, registered: Boolean(note.buyerGstin), lines: note.lines };
    for (const l of note.lines) { nilAdd(d, l, -1); hsnAdd(d, l, -1); }
    const items = byRate(note.lines.map((l) => ({ ...l, ratePercent: l.taxPercent, taxability: l.taxability ?? "exempt" })));
    if (!items.length) continue;
    const base = { noteId: note.id, noteNo: note.noteNo, day: istDay(note.date), noteType: "C" as const, invoiceNo: original.invoiceNo, invoiceDay: istDay(original.issuedAt ?? original.createdAt), valuePaise: note.totalPaise, placeOfSupply: supply.placeOfSupply, items };
    if (note.buyerGstin) cdnr.push({ ctin: note.buyerGstin, ...base });
    else if (isB2cl(original, supply)) cdnur.push({ type: "B2CL", ...base });
    else b2csAdd(supply, items.map(neg));
  }

  const docs: DocSeries[] = [];
  const docSummary = (nature: DocSeries["nature"], live: string[], dead: string[]) => {
    const bySeries = new Map<string, { nos: string[]; cancelled: number }>();
    for (const [no, isDead] of [...live.map((n) => [n, false] as const), ...dead.map((n) => [n, true] as const)]) {
      const s = bySeries.get(series(no)) ?? { nos: [], cancelled: 0 };
      s.nos.push(no);
      if (isDead) s.cancelled++;
      bySeries.set(series(no), s);
    }
    for (const [name, s] of [...bySeries].sort(([a], [b]) => a.localeCompare(b))) {
      const sorted = s.nos.sort();
      docs.push({ nature, series: name, from: sorted[0]!, to: sorted.at(-1)!, total: sorted.length, cancelled: s.cancelled, net: sorted.length - s.cancelled });
    }
  };
  docSummary("Invoices for outward supply", invoices.map((x) => x.inv.invoiceNo), cancelled.map((i) => i.invoiceNo));
  docSummary("Credit Note", notes.map((x) => x.note.noteNo), cancelledNotes.map((n) => n.noteNo));

  const totals = zero();
  for (const x of [...b2b, ...b2cl]) for (const r of x.items) addTotals(totals, r);
  for (const r of b2cs.values()) addTotals(totals, r);
  for (const x of [...cdnr, ...cdnur]) for (const r of x.items) addTotals(totals, r, -1);
  // rows a credit note cancelled out entirely carry nothing to report
  const nonZero = (r: { taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number }) => r.taxablePaise !== 0 || r.igstPaise !== 0 || r.cgstPaise !== 0 || r.sgstPaise !== 0;
  const sortHsn = (m: Map<string, HsnRow>) => [...m.values()].filter(nonZero).sort((a, b) => a.hsnSac.localeCompare(b.hsnSac) || a.ratePercent - b.ratePercent);

  return {
    gstin,
    period: { from: q.from, to: q.to },
    b2b,
    b2cl,
    b2cs: [...b2cs.values()].filter(nonZero).sort((a, b) => a.supplyType.localeCompare(b.supplyType) || a.placeOfSupply.localeCompare(b.placeOfSupply) || a.ratePercent - b.ratePercent),
    cdnr,
    cdnur,
    nil: [...nil.values()].sort((a, b) => a.description.localeCompare(b.description)),
    hsn: { b2b: sortHsn(hsn.b2b), b2c: sortHsn(hsn.b2c) },
    docs,
    /** Net taxable value and tax of taxable outward supplies (invoices less credit notes). */
    totals,
    verifyWithCA: VERIFY_WITH_CA,
  };
}

export type Gstr1 = Awaited<ReturnType<typeof gstr1>>;
