import type { Gstr1 } from "../gst/gstr1";
import type { Gstr3b } from "../gst/gstr3b";
import { ratePct, rupees, toCsv } from "./csv";

/** GSTR-1 sections as CSV files (our own columns, close to the GST offline tool's). Each ends with a TOTAL row. */
export function gstr1Csv(r: Gstr1, opts: { bom?: boolean } = {}): Record<"b2b" | "b2cl" | "b2cs" | "cdnr" | "cdnur" | "nil" | "hsn" | "docs", string> {
  const inv = (rows: (Gstr1["b2cl"][number] & { ctin?: string })[], withCtin: boolean) => {
    const out: string[][] = [];
    const t = [0, 0, 0, 0];
    for (const i of rows) for (const it of i.items) {
      out.push([...(withCtin ? [i.ctin ?? ""] : []), i.invoiceNo, i.day, rupees(i.valuePaise), i.placeOfSupply, ...(withCtin ? [i.reverseCharge] : []), ratePct(it.ratePercent), rupees(it.taxablePaise), rupees(it.igstPaise), rupees(it.cgstPaise), rupees(it.sgstPaise)]);
      t[0]! += it.taxablePaise; t[1]! += it.igstPaise; t[2]! += it.cgstPaise; t[3]! += it.sgstPaise;
    }
    out.push([...(withCtin ? [""] : []), "TOTAL", "", "", "", ...(withCtin ? [""] : []), "", ...t.map((x) => rupees(x))]);
    return out;
  };
  const notes = (rows: (Gstr1["cdnr"][number] | Gstr1["cdnur"][number])[], first: (n: (typeof rows)[number]) => string) => {
    const out: string[][] = [];
    const t = [0, 0, 0, 0];
    for (const n of rows) for (const it of n.items) {
      out.push([first(n), n.noteNo, n.day, n.noteType, n.invoiceNo, n.invoiceDay, rupees(n.valuePaise), n.placeOfSupply, ratePct(it.ratePercent), rupees(it.taxablePaise), rupees(it.igstPaise), rupees(it.cgstPaise), rupees(it.sgstPaise)]);
      t[0]! += it.taxablePaise; t[1]! += it.igstPaise; t[2]! += it.cgstPaise; t[3]! += it.sgstPaise;
    }
    out.push(["", "TOTAL", "", "", "", "", "", "", "", ...t.map((x) => rupees(x))]);
    return out;
  };
  const tax = ["Taxable value", "IGST", "CGST", "SGST"];
  const b2csRows = r.b2cs.map((x) => [x.supplyType, x.placeOfSupply, ratePct(x.ratePercent), rupees(x.taxablePaise), rupees(x.igstPaise), rupees(x.cgstPaise), rupees(x.sgstPaise)]);
  const s = (f: (x: Gstr1["b2cs"][number]) => number) => rupees(r.b2cs.reduce((a, x) => a + f(x), 0));
  b2csRows.push(["TOTAL", "", "", s((x) => x.taxablePaise), s((x) => x.igstPaise), s((x) => x.cgstPaise), s((x) => x.sgstPaise)]);
  const nilRows = r.nil.map((x) => [x.description, rupees(x.nilRatedPaise), rupees(x.exemptedPaise), rupees(x.nonGstPaise)]);
  const n = (f: (x: Gstr1["nil"][number]) => number) => rupees(r.nil.reduce((a, x) => a + f(x), 0));
  nilRows.push(["TOTAL", n((x) => x.nilRatedPaise), n((x) => x.exemptedPaise), n((x) => x.nonGstPaise)]);
  const hsnRows: string[][] = [];
  for (const [kind, rows] of [["B2B", r.hsn.b2b], ["B2C", r.hsn.b2c]] as const)
    for (const h of rows) hsnRows.push([kind, h.hsnSac, h.taxability, ratePct(h.ratePercent), String(h.qty), rupees(h.totalValuePaise), rupees(h.taxablePaise), rupees(h.igstPaise), rupees(h.cgstPaise), rupees(h.sgstPaise)]);
  const all = [...r.hsn.b2b, ...r.hsn.b2c];
  const hs = (f: (x: (typeof all)[number]) => number) => rupees(all.reduce((a, x) => a + f(x), 0));
  hsnRows.push(["TOTAL", "", "", "", "", hs((x) => x.totalValuePaise), hs((x) => x.taxablePaise), hs((x) => x.igstPaise), hs((x) => x.cgstPaise), hs((x) => x.sgstPaise)]);
  return {
    b2b: toCsv(["GSTIN of recipient", "Invoice No", "Invoice date", "Invoice value", "Place of supply", "Reverse charge", "Rate", ...tax], inv(r.b2b, true), opts),
    b2cl: toCsv(["Invoice No", "Invoice date", "Invoice value", "Place of supply", "Rate", ...tax], inv(r.b2cl, false), opts),
    b2cs: toCsv(["Type", "Place of supply", "Rate", ...tax], b2csRows, opts),
    cdnr: toCsv(["GSTIN of recipient", "Note No", "Note date", "Note type", "Invoice No", "Invoice date", "Note value", "Place of supply", "Rate", ...tax], notes(r.cdnr, (x) => ("ctin" in x ? x.ctin : "")), opts),
    cdnur: toCsv(["UR type", "Note No", "Note date", "Note type", "Invoice No", "Invoice date", "Note value", "Place of supply", "Rate", ...tax], notes(r.cdnur, () => "B2CL"), opts),
    nil: toCsv(["Description", "Nil rated", "Exempted", "Non-GST"], nilRows, opts),
    hsn: toCsv(["Section", "HSN/SAC", "Taxability", "Rate", "Quantity", "Total value", ...tax], hsnRows, opts),
    docs: toCsv(["Nature of document", "Series", "From", "To", "Total", "Cancelled", "Net issued"], r.docs.map((d) => [d.nature, d.series, d.from, d.to, String(d.total), String(d.cancelled), String(d.net)]), opts),
  };
}

export function gstr3bCsv(r: Gstr3b, opts: { bom?: boolean } = {}): string {
  const t = r.outwardTaxable;
  const rows: string[][] = [
    ["3.1(a)", "Outward taxable supplies", "", rupees(t.taxablePaise), rupees(t.igstPaise), rupees(t.cgstPaise), rupees(t.sgstPaise)],
    ["3.1(c)", "Nil-rated and exempted supplies", "", rupees(r.outwardNilExemptPaise), "", "", ""],
    ["3.1(e)", "Non-GST outward supplies", "", rupees(r.outwardNonGstPaise), "", "", ""],
    ...r.interStateUnregistered.map((x) => ["3.2", "Inter-state supplies to unregistered persons", x.placeOfSupply, rupees(x.taxablePaise), rupees(x.igstPaise), "", ""]),
  ];
  return toCsv(["Table", "Nature of supplies", "Place of supply", "Taxable value", "IGST", "CGST", "SGST"], rows, opts);
}
