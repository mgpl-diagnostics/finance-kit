import { ConflictError, ValidationError, type Id, type Repositories, type Voucher } from "@mgpl-diagnostics/db-kit";
import { ledgerId, line, post, profitAndLoss } from "../posting";
import { fyRange } from "../util";

/**
 * Closes a financial year, in one transaction:
 * 1. takes the organisation's lock row exclusively (no posting can land meanwhile);
 * 2. for each branch, a Closing voucher dated 31 March 23:59:59.999 IST reverses that branch's income
 *    and expense balances for the year and moves the result to "Profit & Loss A/c" (Reserves & Surplus);
 * 3. locks the organisation up to the year end.
 * Balance-sheet ledgers carry forward as they are (balances are running sums), so the next year opens
 * with the closing balances, P&L ledgers start at zero, and profitAndLoss for the closed year still
 * shows its result (closing vouchers are left out of it).
 */
export async function closeFinancialYear(repos: Repositories, input: { orgId: Id; fy: string; now?: Date }, actorId?: Id): Promise<{ vouchers: Voucher[]; netProfitPaise: number }> {
  const now = input.now ?? new Date();
  const { from, to, last } = fyRange(input.fy);
  if (now.getTime() <= to.getTime()) throw new ConflictError(`Financial year ${input.fy} has not ended`);
  return repos.transaction(async (tx) => {
    const [lock] = await tx.periodLocks.hold(input.orgId, ["org"], "update");
    if (lock!.lockedUpTo && lock!.lockedUpTo.getTime() >= to.getTime()) throw new ConflictError(`The books are locked up to ${lock!.lockedUpTo.toISOString()}: ${input.fy} is closed or locked`);
    if ((await tx.vouchers.listByDate({ orgId: input.orgId, type: "closing", from, to })).length) throw new ConflictError(`${input.fy} already has a closing voucher`);
    for (const l of await tx.ledgers.find({ orgId: input.orgId })) {
      const g = await tx.accountGroups.get(l.groupId);
      let p = g;
      while (p?.parentId) p = await tx.accountGroups.get(p.parentId);
      if ((p?.nature === "income" || p?.nature === "expenses") && l.openingPaise !== 0) throw new ValidationError(`Income / expense ledger "${l.name}" has an opening balance; move it to a voucher first`);
    }
    const retained = await ledgerId(tx, input.orgId, "retained_earnings");
    const vouchers: Voucher[] = [];
    let total = 0;
    for (const branch of await tx.branches.find({ orgId: input.orgId }, { sort: { field: "code" } })) {
      const pl = await profitAndLoss(tx, { orgId: input.orgId, branchId: branch.id, from, to });
      const entries = [
        ...pl.income.flatMap((g) => g.ledgers.map((x) => line(x.ledger.id, x.amountPaise))),
        ...pl.expenses.flatMap((g) => g.ledgers.map((x) => line(x.ledger.id, -x.amountPaise))),
        line(retained, -pl.netProfitPaise),
      ].filter((e) => e.debitPaise > 0 || e.creditPaise > 0);
      if (entries.length < 2) continue;
      // A branch whose cash day 31 March is closed is locked through the closing instant. Inside this
      // transaction (its lock row held exclusively) the lock steps back by 1 ms for the closing voucher
      // and is restored before commit, so nobody else ever sees it open.
      const [bl] = await tx.periodLocks.hold(input.orgId, [branch.id], "update");
      const held = bl!.lockedUpTo && bl!.lockedUpTo.getTime() >= to.getTime() ? bl!.lockedUpTo : null;
      if (held) await tx.periodLocks.update(bl!.id, { lockedUpTo: new Date(to.getTime() - 1) });
      vouchers.push(await post(tx, { orgId: input.orgId, branchId: branch.id, type: "closing", date: to, narration: `Year-end closing ${input.fy} (${branch.code})`, entries }, actorId));
      if (held) await tx.periodLocks.update(bl!.id, { lockedUpTo: held });
      total += pl.netProfitPaise;
    }
    await tx.periodLocks.update(lock!.id, { lockedUpTo: to, reason: `year end ${input.fy} (${last})`, updatedBy: actorId ?? null });
    await tx.audit.log({ orgId: input.orgId, userId: actorId ?? null, action: "finance.year.close", entity: "period_lock", entityId: lock!.id, data: { fy: input.fy, netProfitPaise: total, vouchers: vouchers.map((v) => v.voucherNo) } });
    return { vouchers, netProfitPaise: total };
  });
}
