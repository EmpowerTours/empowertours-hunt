// ---------------------------------------------------------------------------
// Retrying a transaction that Postgres refused to serialize.
//
// WHY THIS EXISTS: the spawn collect commits at Serializable, because the
// auto-approval daily cap is a SUM over rows the transaction is itself
// inserting. That is the right isolation level — it turns a concurrent
// overshoot into an abort instead of an overspend. But an abort is not an
// answer, and until this module existed nothing converted it into one:
//
//   * Postgres raised 40001,
//   * Prisma surfaced it as P2010 with meta.code "40001",
//   * the route's catch knew only CollectRejected and P2002, so it rethrew,
//   * and a player standing at a spawn got HTTP 500 "internal error" with no
//     hint that trying again would work — and NO ClaimAttempt row, so the
//     audit trail was missing exactly the events that happened under load.
//
// Measured before the fix: at ten concurrent collects, seven came back 500 and
// the budget ceiling never got to speak. Nothing was overspent — the failure
// was opaque, not unsafe.
//
// RETRYING IS ONLY SAFE BECAUSE THE UNIT IS A TRANSACTION. An aborted
// transaction committed nothing, so running it again is running it for the
// first time. Never wrap anything with an external effect in this — a
// broadcast, an email, a file write. In this codebase that means the payout
// SEND is emphatically not a candidate: `sendApprovedPayout` is guarded by a
// compare-and-set precisely because a retry there could pay twice.
// ---------------------------------------------------------------------------

/**
 * SQLSTATEs worth another attempt.
 *
 * 40001 serialization_failure — two transactions could not both be ordered.
 * 40P01 deadlock_detected     — Postgres broke a cycle by aborting one side.
 *
 * Both mean "nothing happened, and it might not happen again". Nothing else
 * belongs here: a unique violation retried is a unique violation twice, and a
 * check-constraint failure will fail identically forever.
 */
export const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set([
  "40001",
  "40P01",
]);

/** Prisma's own code for a write conflict or deadlock it recognised itself. */
const PRISMA_WRITE_CONFLICT = "P2034";
/** Raw query failed. The SQLSTATE is in `meta.code`. */
const PRISMA_RAW_FAILED = "P2010";

function readCode(e: unknown): string | null {
  if (typeof e !== "object" || e === null) return null;
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function readMetaCode(e: unknown): string | null {
  if (typeof e !== "object" || e === null) return null;
  const meta = (e as { meta?: unknown }).meta;
  if (typeof meta !== "object" || meta === null) return null;
  const code = (meta as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * Whether this failure means "nothing committed, try again".
 *
 * Deliberately checks three shapes. The ceilings are `$executeRaw`, so they
 * arrive as P2010 with the SQLSTATE in meta; a Prisma-native write conflict
 * arrives as P2034; and a driver error that never passed through Prisma's
 * wrapper carries the SQLSTATE as its own `code`. Missing any one of them
 * reintroduces the 500 for a subset of collects, which is the bug this
 * function exists to close.
 *
 * Reject-by-default: anything unrecognised is NOT retryable.
 */
export function isRetryableTransactionError(e: unknown): boolean {
  const code = readCode(e);
  if (code === PRISMA_WRITE_CONFLICT) return true;
  if (code !== null && RETRYABLE_SQLSTATES.has(code)) return true;
  if (code === PRISMA_RAW_FAILED) {
    const sqlstate = readMetaCode(e);
    return sqlstate !== null && RETRYABLE_SQLSTATES.has(sqlstate);
  }
  return false;
}

/** Every attempt was refused. The caller decides what the player is told. */
export class SerializationExhausted extends Error {
  constructor(
    readonly attempts: number,
    readonly lastError: unknown,
  ) {
    super(`transaction could not be serialized after ${attempts} attempts`);
    this.name = "SerializationExhausted";
  }
}

export interface RetryOptions {
  /** Total attempts INCLUDING the first. */
  attempts?: number;
  /** First backoff, in ms. Doubles each attempt, before jitter. */
  baseDelayMs?: number;
  /** Ceiling on a single backoff, so contention cannot stall a request path. */
  maxDelayMs?: number;
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests. */
  random?: () => number;
  /** Called before each retry. Ops signal — contention should be visible. */
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `op` until it succeeds, fails for a non-retryable reason, or runs out of
 * attempts.
 *
 * FULL JITTER, not a fixed backoff. The transactions that collide here collided
 * because they arrived together; retrying them together after the same delay
 * recreates the collision exactly. `random() * ceiling` spreads them out, which
 * is the whole point of the sleep.
 *
 * BOUNDED, because this sits in a request path. Four attempts at 20/40/80ms
 * ceilings is at most ~140ms of added latency before giving up, and giving up
 * is an answer — an unbounded retry would convert contention into a pile of
 * held connections, which is a worse outage than the one it is avoiding.
 */
export async function withTransactionRetry<T>(
  op: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 20;
  const maxDelayMs = options.maxDelayMs ?? 250;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  if (!(Number.isInteger(attempts) && attempts >= 1)) {
    throw new RangeError("attempts must be a positive integer");
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await op(attempt);
    } catch (e) {
      // A deliberate rejection thrown from inside the transaction — a ceiling
      // refusing, a unique violation — is an ANSWER. Retrying it would turn
      // one refusal into four and change nothing.
      if (!isRetryableTransactionError(e)) throw e;

      lastError = e;
      if (attempt === attempts) break;

      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delayMs = Math.floor(random() * ceiling);
      options.onRetry?.(attempt, delayMs, e);
      await sleep(delayMs);
    }
  }

  throw new SerializationExhausted(attempts, lastError);
}
