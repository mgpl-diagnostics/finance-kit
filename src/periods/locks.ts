import { NotFoundError, type Id, type PeriodLock, type Repositories } from "@mgpl-diagnostics/db-kit";
import { endOfIstDay, istDay } from "../util";

/**
 * Lock dates. No voucher dated on or before an organisation's or a branch's lock date may be posted
 * or cancelled. The accounting engine enforces it inside every posting transaction (db-kit
 * assertPeriodOpen); this module sets and reads the dates.
 */

export interface LockInput {
  orgId: Id;
  /** Omit or null for the whole organisation. */
  branchId?: Id | null;
  /** Last locked IST day, "2026-09-30"; null removes the lock. */
  upTo: string | null;
  reason?: string;
}

/**
 * Sets a lock date. Takes the lock row exclusively, so postings in flight finish first and new ones
 * see the new date. Moving a lock backwards (re-opening days) is allowed and audited.
 */
export async function setLockDate(repos: Repositories, input: LockInput, actorId?: Id): Promise<PeriodLock> {
  const lockedUpTo = input.upTo === null ? null : endOfIstDay(input.upTo);
  const scope = input.branchId ?? "org";
  return repos.transaction(async (tx) => {
    if (input.branchId) {
      const b = await tx.branches.get(input.branchId);
      if (!b || b.orgId !== input.orgId) throw new NotFoundError("Branch", input.branchId);
    }
    const [lock] = await tx.periodLocks.hold(input.orgId, [scope], "update");
    const before = lock!.lockedUpTo;
    const out = (await tx.periodLocks.update(lock!.id, { lockedUpTo, reason: input.reason, updatedBy: actorId ?? null }))!;
    await tx.audit.log({
      orgId: input.orgId, branchId: input.branchId ?? null, userId: actorId ?? null, action: "finance.period.lock", entity: "period_lock", entityId: out.id,
      data: { scope, from: before ? istDay(before) : null, to: input.upTo, reason: input.reason ?? null },
    });
    return out;
  });
}

/** The lock that applies to a branch: the later of the organisation's and the branch's dates. */
export async function lockDateFor(repos: Repositories, orgId: Id, branchId?: Id): Promise<Date | null> {
  const locks = await repos.periodLocks.find({ orgId });
  const dates = locks.filter((l) => l.scope === "org" || l.scope === branchId).map((l) => l.lockedUpTo).filter((d): d is Date => d !== null);
  return dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
}

/** Every lock row of the organisation (scope "org" and branches). */
export const listLocks = (repos: Repositories, orgId: Id) => repos.periodLocks.find({ orgId }, { sort: { field: "scope" } });
