import {
  ConflictError, financialYear, invoiceBalance, NotFoundError, ValidationError, type CreditNote, type CreditNoteLine, type Id, type Invoice,
  type Repositories,
} from "@mgpl-diagnostics/db-kit";
import { invoiceTaxLines, splitTax } from "../gst/breakup";
import { supplyResolver } from "../gst/supply";
import { assertFinancePosting, ledgerIds, line, post, receivableLedger } from "../posting";

export interface CreditNoteInput {
  orgId: Id;
  invoiceId: Id;
  reason: string;
  /**
   * Lines to credit by invoice item index, with the taxable value to take off (default: what is left
   * of that line). Omit `lines` to credit everything not yet credited.
   */
  lines?: { itemIndex: number; taxablePaise?: number }[];
  date?: Date;
}

export const creditNoteCounterKey = (orgId: Id, branchCode: string, fy: string) => `creditnote:${orgId}:${branchCode}:${fy}`;
/** "MGPL/RPR01/CN/2026-27/000001" */
export const formatCreditNoteNo = (orgCode: string, branchCode: string, fy: string, seq: number) => `${orgCode}/${branchCode}/CN/${fy}/${String(seq).padStart(6, "0")}`;

/**
 * Issues a GST credit note against an invoice (refund or price correction), in one transaction:
 * locks the invoice, computes each line's taxable value and tax (the last credit of a line takes
 * exactly what is left, so credits never exceed the invoice), numbers it, reduces what the invoice
 * owes, and posts a Credit Note voucher: Dr Sales, Dr Output GST, ± Round Off, Cr the receivable.
 * When the invoice was already paid, `refundablePaise` is what to refund (db-kit recordPayment, kind "refund").
 */
export async function issueCreditNote(repos: Repositories, input: CreditNoteInput, actorId?: Id): Promise<{ creditNote: CreditNote; invoice: Invoice; refundablePaise: number }> {
  assertFinancePosting(repos);
  if (!input.reason?.trim()) throw new ValidationError("A credit note needs a reason");
  const date = input.date ?? new Date();
  return repos.transaction(async (tx) => {
    const inv = await tx.invoices.getForUpdate(input.invoiceId);
    if (!inv || inv.orgId !== input.orgId) throw new NotFoundError("Invoice", input.invoiceId);
    if (inv.status === "cancelled" || inv.status === "draft") throw new ConflictError(`Invoice ${inv.invoiceNo} is ${inv.status}`);
    if (inv.issuedAt && date.getTime() < inv.issuedAt.getTime()) throw new ValidationError("A credit note cannot be dated before its invoice");
    const supply = await supplyResolver(tx)(inv);
    const tax = invoiceTaxLines(inv, supply.interState);
    const previous = await tx.creditNotes.find({ invoiceId: inv.id, status: "issued" });
    const done = (idx: number, f: (l: CreditNoteLine) => number) => previous.flatMap((n) => n.lines).filter((l) => l.itemIndex === idx).reduce((s, l) => s + f(l), 0);

    const wanted: { itemIndex: number; taxablePaise?: number }[] = input.lines ?? tax.map((t) => ({ itemIndex: t.itemIndex }));
    if (new Set(wanted.map((w) => w.itemIndex)).size !== wanted.length) throw new ValidationError("Each invoice line may appear once");
    const lines: CreditNoteLine[] = [];
    for (const w of wanted) {
      const t = tax[w.itemIndex];
      if (!t) throw new ValidationError(`Invoice ${inv.invoiceNo} has no line ${w.itemIndex}`);
      const leftTaxable = t.taxablePaise - done(w.itemIndex, (l) => l.taxablePaise);
      const leftTax = t.taxPaise - done(w.itemIndex, (l) => l.taxPaise);
      if (leftTaxable <= 0) {
        if (input.lines) throw new ConflictError(`Line ${w.itemIndex} of ${inv.invoiceNo} is already fully credited`);
        continue;
      }
      const amount = w.taxablePaise ?? leftTaxable;
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > leftTaxable) throw new ValidationError(`Line ${w.itemIndex}: credit 1–${leftTaxable} paise of taxable value`);
      const lineTax = amount === leftTaxable ? leftTax : Math.min(leftTax, Math.round((amount * t.ratePercent) / 100));
      lines.push({
        itemIndex: t.itemIndex, name: t.name, code: t.code, hsnSac: t.hsnSac || undefined, taxability: t.taxability, taxPercent: t.ratePercent,
        taxablePaise: amount, taxPaise: lineTax, ...splitTax(lineTax, supply.interState),
      });
    }
    if (!lines.length) throw new ConflictError(`Invoice ${inv.invoiceNo} is already fully credited`);

    const total = (f: (l: CreditNoteLine) => number) => lines.reduce((s, l) => s + f(l), 0);
    // when this note completes the invoice, it also reverses the invoice's round-off, so credits = invoice total
    const complete = tax.every((t) => t.taxablePaise - done(t.itemIndex, (l) => l.taxablePaise) - lines.filter((l) => l.itemIndex === t.itemIndex).reduce((s, l) => s + l.taxablePaise, 0) === 0);
    const roundOff = complete ? inv.roundOffPaise : 0;
    const totalPaise = total((l) => l.taxablePaise) + total((l) => l.taxPaise) + roundOff;

    const [org, branch] = await Promise.all([tx.orgs.get(inv.orgId), tx.branches.get(inv.branchId)]);
    const fy = financialYear(date);
    const seq = await tx.counters.next(creditNoteCounterKey(inv.orgId, branch!.code, fy));
    const k = await ledgerIds(tx, inv.orgId, ["sales", "cgst", "sgst", "igst", "round_off"] as const);
    const noteNo = formatCreditNoteNo(org!.code, branch!.code, fy, seq);
    const voucher = await post(tx, {
      orgId: inv.orgId, branchId: inv.branchId, type: "credit_note", date, invoiceId: inv.id,
      narration: `Credit note ${noteNo} against ${inv.invoiceNo}: ${input.reason.trim()}`,
      entries: [
        line(k.sales, total((l) => l.taxablePaise)),
        line(k.cgst, total((l) => l.cgstPaise)),
        line(k.sgst, total((l) => l.sgstPaise)),
        line(k.igst, total((l) => l.igstPaise)),
        line(k.round_off, roundOff),
        line(await receivableLedger(tx, inv), -totalPaise, inv.id),
      ].filter((e) => e.debitPaise > 0 || e.creditPaise > 0),
    }, actorId);
    const creditNote = await tx.creditNotes.create({
      orgId: inv.orgId, branchId: inv.branchId, invoiceId: inv.id, customerId: inv.customerId ?? null, noteNo, date, reason: input.reason.trim(), lines,
      taxablePaise: total((l) => l.taxablePaise), taxPaise: total((l) => l.taxPaise), cgstPaise: total((l) => l.cgstPaise), sgstPaise: total((l) => l.sgstPaise),
      igstPaise: total((l) => l.igstPaise), roundOffPaise: roundOff, totalPaise, placeOfSupply: supply.placeOfSupply, buyerGstin: inv.buyerGstin ?? null,
      voucherId: voucher.id, status: "issued", createdBy: actorId ?? null,
    });
    const credited = (inv.creditedPaise ?? 0) + totalPaise;
    const invoice = (await tx.invoices.update(inv.id, { creditedPaise: credited, ...invoiceBalance({ totalPaise: inv.totalPaise, creditedPaise: credited }, inv.paidPaise) }))!;
    await tx.audit.log({ orgId: inv.orgId, branchId: inv.branchId, userId: actorId ?? null, action: "finance.credit_note.issue", entity: "credit_note", entityId: creditNote.id, data: { noteNo, invoiceNo: inv.invoiceNo, totalPaise } });
    return { creditNote, invoice, refundablePaise: Math.max(0, inv.paidPaise - (inv.totalPaise - credited)) };
  });
}
