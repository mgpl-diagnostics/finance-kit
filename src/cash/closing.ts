import { ConflictError, NotFoundError, ValidationError, type CashClosing, type CashDenomination, type Id, type Repositories } from "@mgpl-diagnostics/db-kit";
import { balanceOf, ledgerIds, line, post } from "../posting";
import { assertDay, endOfIstDay } from "../util";

export interface CashClosingInput {
  orgId: Id;
  branchId: Id;
  /** IST day being closed, "2026-10-14". */
  day: string;
  countedPaise: number;
  /** Notes and coins counted; must add up to countedPaise. */
  denominations?: CashDenomination[];
  notes?: string;
}

/**
 * Day-end cash closing for a branch, in one transaction:
 * 1. takes the branch's lock row exclusively, so no posting can land while the cash is counted;
 * 2. book balance = the branch's postings on the Cash ledger up to the end of the day;
 * 3. a difference posts a Journal at 23:59:59.999 IST: short → Dr Cash Short / Excess, Cr Cash;
 *    excess → Dr Cash, Cr Cash Short / Excess;
 * 4. the branch's lock date moves to the end of that day: the closed day rejects new postings.
 * Days close in order; a day on or before the branch's lock date cannot be closed again.
 */
export async function closeCashDay(repos: Repositories, input: CashClosingInput, actorId?: Id): Promise<CashClosing> {
  assertDay(input.day);
  if (!(Number.isSafeInteger(input.countedPaise) && input.countedPaise >= 0)) throw new ValidationError("countedPaise must be whole paise ≥ 0");
  if (input.denominations) {
    for (const d of input.denominations) if (!(Number.isSafeInteger(d.valuePaise) && d.valuePaise > 0 && Number.isInteger(d.count) && d.count >= 0)) throw new ValidationError("Bad denomination");
    const counted = input.denominations.reduce((s, d) => s + d.valuePaise * d.count, 0);
    if (counted !== input.countedPaise) throw new ValidationError(`Denominations add up to ${counted} paise, not ${input.countedPaise}`);
  }
  const end = endOfIstDay(input.day);
  return repos.transaction(async (tx) => {
    const branch = await tx.branches.get(input.branchId);
    if (!branch || branch.orgId !== input.orgId) throw new NotFoundError("Branch", input.branchId);
    const [lock] = await tx.periodLocks.hold(input.orgId, [input.branchId], "update");
    if (lock!.lockedUpTo && lock!.lockedUpTo.getTime() >= end.getTime()) throw new ConflictError(`${branch.code} is closed up to ${lock!.lockedUpTo.toISOString()}; ${input.day} cannot be closed again`);
    if (await tx.cashClosings.findOne({ orgId: input.orgId, branchId: input.branchId, day: input.day })) throw new ConflictError(`${input.day} is already closed for ${branch.code}`);
    const k = await ledgerIds(tx, input.orgId, ["cash", "cash_short_excess"] as const);
    const book = await balanceOf(tx, { orgId: input.orgId, branchId: input.branchId, ledgerId: k.cash, asOf: end });
    const diff = input.countedPaise - book;
    const voucher = diff === 0 ? null : await post(tx, {
      orgId: input.orgId, branchId: input.branchId, type: "journal", date: end,
      narration: `Cash ${diff < 0 ? "short" : "excess"} at day-end ${input.day} (book ${book}, counted ${input.countedPaise} paise)`,
      entries: [line(k.cash, diff), line(k.cash_short_excess, -diff)],
    }, actorId);
    const closing = await tx.cashClosings.create({
      orgId: input.orgId, branchId: input.branchId, day: input.day, bookPaise: book, countedPaise: input.countedPaise, differencePaise: diff,
      denominations: input.denominations, voucherId: voucher?.id ?? null, closedBy: actorId ?? null, notes: input.notes,
    });
    await tx.periodLocks.update(lock!.id, { lockedUpTo: end, reason: `cash closed ${input.day}`, updatedBy: actorId ?? null });
    await tx.audit.log({ orgId: input.orgId, branchId: input.branchId, userId: actorId ?? null, action: "finance.cash.close", entity: "cash_closing", entityId: closing.id, data: { day: input.day, bookPaise: book, countedPaise: input.countedPaise } });
    return closing;
  });
}
