// One run at a time, per leash.
//
// The failure this prevents is not a lost update, it is a DOUBLED TRADE. Two
// runs overlap; both read the same open position because the first one's fill
// has not settled; both decide to close; both send a close for the full size.
// planClose clamps to what the venue reported, which was the full size to each
// of them, so the position does not close — it flips to the other side at twice
// the intended trade, and the agent has now opened something nobody asked for,
// in a direction nobody chose.
//
// It is a LEASE and not a lock. A run that dies between taking it and finishing
// — a timeout, a deploy, a crashed container — must not wedge a hunter's agent
// until somebody notices. The lease expires on its own.
//
// It is taken with a CONDITIONAL UPDATE, not read-then-write. "Is it free? then
// take it" across two statements is the same race one level up; the database
// decides the winner, and it does so by counting how many rows it changed.

import { prisma } from "@/lib/db/prisma";

/**
 * How long a run may hold a leash.
 *
 * Long enough to cover the slowest honest run — two socket reads, a proposer
 * call and an order — and short enough that a dead run is forgotten before the
 * next scheduled tick would have mattered. A minute-by-minute poll skipping one
 * or two ticks after a crash is invisible; skipping an hour is not.
 */
export const LEASE_MS = 90_000;

/**
 * Try to take the lease on one leash.
 *
 * Returns true only if THIS call took it. The `updateMany` matches a row only
 * when the lease is absent or already expired, so exactly one of any number of
 * concurrent callers sees a count of 1 — the rest see 0 and must not act.
 */
export async function takeAgentLease(
  cotaId: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const now = new Date(nowMs);
  const res = await prisma.cota.updateMany({
    where: {
      id: cotaId,
      OR: [{ agentLeaseUntil: null }, { agentLeaseUntil: { lt: now } }],
    },
    data: { agentLeaseUntil: new Date(nowMs + LEASE_MS) },
  });
  return res.count === 1;
}

/**
 * Give the lease back early.
 *
 * Best-effort on purpose: if this fails the lease still expires, so a caller
 * must never treat releasing as something that has to succeed. Not releasing
 * costs at most LEASE_MS of one leash being skipped.
 */
export async function releaseAgentLease(cotaId: string): Promise<void> {
  try {
    await prisma.cota.updateMany({
      where: { id: cotaId },
      data: { agentLeaseUntil: null },
    });
  } catch {
    // Expiry is the backstop. Nothing to do here.
  }
}
