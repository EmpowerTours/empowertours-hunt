import { Redis } from "@upstash/redis";
import { Ratelimit, type Duration } from "@upstash/ratelimit";

// ---------------------------------------------------------------------------
// Rate limiting.
//
// Two backends, one interface:
//
//   * Upstash Redis when UPSTASH_REDIS_REST_URL / _TOKEN are set. This is the
//     only backend that limits anything once more than one instance runs.
//   * A BOUNDED in-memory token bucket otherwise, and as a degraded fallback
//     for non-money paths when Redis errors.
//
// The in-memory limiter replaces a timestamp-array implementation with a
// confirmed defect (M1): it appended a timestamp on EVERY call, including calls
// it had already decided to block. An attacker who ignores the 429 therefore
// grew the array without bound inside the window (~60k entries at a modest
// request rate), and every subsequent request re-filtered the whole array — a
// quadratic CPU amplifier that let one blocked player saturate a core. The old
// Map was also never pruned, so it was an unbounded memory leak keyed on
// attacker-chosen input.
//
// The fix is structural, not a tuning change:
//
//   * a token bucket is O(1) per call and stores two numbers, so there is no
//     array to re-scan and no way for call volume to make a call more expensive;
//   * a blocked caller consumes nothing and writes no new state;
//   * the map is capped and evicts, so distinct keys cannot grow it forever.
// ---------------------------------------------------------------------------

export type LimitName =
  | "claim"
  | "hint"
  | "spawn"
  | "register"
  | "cota"
  | "browse"
  | "admin";

export interface LimitResult {
  ok: boolean;
  remaining: number;
  resetAt: number;
}

interface Quota {
  /** Requests permitted per window. Also the burst capacity. */
  tokens: number;
  windowSeconds: number;
}

interface LimitSpec {
  /** Applied when the caller passes a playerId. */
  perPlayer: Quota | null;
  /** Always applied. An unauthenticated caller is limited by this alone. */
  perIp: Quota;
  /**
   * Whether a backend error denies the request. True for anything that can
   * move money or mint an identity: a limiter that fails open on those is not
   * a limiter, it is a fuse an attacker can blow on purpose.
   */
  failClosed: boolean;
}

/**
 * Per-limit defaults. Documented rather than tuned by feel:
 *
 * claim   — THE control that makes a coordinate brute-force expensive. Cache
 *           coordinates are secret, so the only way to find one without walking
 *           to it is to submit positions and read the accept/reject. At 5/min a
 *           25 m cache inside a 1 km² search area needs ~10^3 probes per grid
 *           row, i.e. days of sustained traffic against a limiter that is also
 *           logging every attempt to ClaimAttempt for the abuse queue. A human
 *           standing on a cache needs one request, so this costs a real player
 *           nothing. Strict on purpose.
 * hint    — a quantized distance oracle is still an oracle and volume is what
 *           defeats quantization. Matches the 12/min the route used before.
 * spawn   — spawn coordinates are public, so this bounds collect attempts, not
 *           discovery. Hunt.spawnCooldownSeconds is the real control.
 * register— open signup, so this is flood protection, NOT the sybil bound. The
 *           sybil bound is the hunt budget ceiling plus admin moderation of
 *           Player.active. Loose enough for a shared NAT, tight enough that
 *           scripted signup is not free.
 * admin   — generous, and fails OPEN. An operator locked out of the payout
 *           queue during a Redis blip is a worse outcome than an unlimited
 *           admin, who is already behind a separate and stronger auth control.
 */
const LIMITS: Record<LimitName, LimitSpec> = {
  claim: {
    perPlayer: { tokens: 5, windowSeconds: 60 },
    perIp: { tokens: 20, windowSeconds: 60 },
    failClosed: true,
  },
  hint: {
    perPlayer: { tokens: 12, windowSeconds: 60 },
    perIp: { tokens: 40, windowSeconds: 60 },
    failClosed: false,
  },
  spawn: {
    perPlayer: { tokens: 6, windowSeconds: 60 },
    perIp: { tokens: 20, windowSeconds: 60 },
    failClosed: true,
  },
  register: {
    perPlayer: null,
    perIp: { tokens: 20, windowSeconds: 900 },
    failClosed: true,
  },
  // Signing a Cota moves no money, but it writes an authorisation row and
  // costs a signature recovery. Fails closed for the same reason `claim` does:
  // an unbounded path that records what software may later do on a player's
  // behalf is not one to leave open when the limiter cannot answer.
  cota: {
    perPlayer: { tokens: 10, windowSeconds: 300 },
    perIp: { tokens: 30, windowSeconds: 300 },
    failClosed: true,
  },
  // Reading the hunt list. IP-only, because browsing is the one public path
  // that must work BEFORE anybody has an identity — it is what a person sees
  // when they arrive from a link.
  //
  // failClosed is false here, unlike every money path above. A Redis blip must
  // not turn the front page into an error: nothing is spent by listing hunts,
  // and the worst case of letting it through unlimited is served cache.
  browse: {
    perPlayer: null,
    perIp: { tokens: 60, windowSeconds: 60 },
    failClosed: false,
  },
  admin: {
    perPlayer: { tokens: 60, windowSeconds: 60 },
    perIp: { tokens: 120, windowSeconds: 60 },
    failClosed: false,
  },
};

// --- Redis client ----------------------------------------------------------

let redisClient: Redis | null = null;
let redisResolved = false;

/**
 * Shared Upstash client, or null when the service is not configured.
 *
 * Module-scoped on purpose. The client is stateless over HTTP but constructing
 * one per call throws away every cached lookup the SDK holds.
 */
export function getRedis(): Redis | null {
  if (redisResolved) return redisClient;
  redisResolved = true;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    redisClient = null;
    return null;
  }
  redisClient = new Redis({ url, token });
  return redisClient;
}

// --- Bounded in-memory token bucket ----------------------------------------

interface Bucket {
  tokens: number;
  capacity: number;
  /** ms per token. Cached so the hot path does no division. */
  msPerToken: number;
  updatedAt: number;
}

/**
 * Ceiling on distinct buckets held in memory. The key space is
 * attacker-chosen (IP, playerId), so this must be capped or it is a leak.
 */
const MAX_BUCKETS = 20_000;

export class MemoryTokenBucketLimiter {
  // Map preserves insertion order, which is what makes the LRU eviction below
  // O(1) without a second data structure.
  private readonly buckets = new Map<string, Bucket>();

  /**
   * How far below the cap a prune drives the map, so the cost of pruning is
   * amortised over many inserts instead of paid on every one. Derived from the
   * instance cap, not from a module constant — a module constant silently made
   * the prune a no-op for any limiter not using the default size.
   */
  private readonly pruneTarget: number;

  constructor(private readonly maxBuckets: number = MAX_BUCKETS) {
    this.pruneTarget = Math.max(1, Math.floor(maxBuckets * 0.9));
  }

  get size(): number {
    return this.buckets.size;
  }

  clear(): void {
    this.buckets.clear();
  }

  take(key: string, quota: Quota, now: number = Date.now()): LimitResult {
    const capacity = quota.tokens;
    const msPerToken = (quota.windowSeconds * 1000) / capacity;

    let bucket = this.buckets.get(key);
    if (bucket) {
      // Touch for LRU: delete + set moves it to the end of the iteration order.
      this.buckets.delete(key);
    } else {
      this.evictIfNeeded(now);
      bucket = { tokens: capacity, capacity, msPerToken, updatedAt: now };
    }

    // A quota change (config edit, different limit reusing a key) must not let
    // a stale bucket hold more tokens than the new capacity allows.
    if (bucket.capacity !== capacity || bucket.msPerToken !== msPerToken) {
      bucket.tokens = Math.min(bucket.tokens, capacity);
      bucket.capacity = capacity;
      bucket.msPerToken = msPerToken;
    }

    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed / msPerToken);
    bucket.updatedAt = now;

    // Reject by default: only a bucket that positively holds a whole token is
    // an accept. Written as `if (!(tokens >= 1))` so a NaN — which would make
    // `tokens < 1` false and silently allow — still rejects.
    if (!(bucket.tokens >= 1)) {
      // M1: do NOT consume, and do NOT accumulate anything. A caller that
      // ignores the 429 costs exactly one map lookup and two float ops per
      // request, forever. Re-inserting the existing bucket cannot grow the map.
      this.buckets.set(key, bucket);
      const deficit = Number.isFinite(bucket.tokens) ? 1 - bucket.tokens : 1;
      return {
        ok: false,
        remaining: 0,
        resetAt: now + Math.ceil(deficit * msPerToken),
      };
    }

    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return {
      ok: true,
      remaining: Math.floor(bucket.tokens),
      resetAt: now + Math.ceil((capacity - bucket.tokens) * msPerToken),
    };
  }

  private evictIfNeeded(now: number): void {
    if (this.buckets.size < this.maxBuckets) return;

    // A bucket that has refilled to capacity carries no information: it is
    // indistinguishable from a caller we have never seen. Drop those first,
    // which reclaims idle keys without ever forgiving an active offender.
    //
    // `now` is the caller's clock, not Date.now(). Mixing the two made every
    // bucket look infinitely old under an injected clock and pruned the whole
    // map, including offenders that had not in fact recovered.
    for (const [k, b] of this.buckets) {
      const refilled = b.tokens + Math.max(0, now - b.updatedAt) / b.msPerToken;
      if (refilled >= b.capacity) this.buckets.delete(k);
      if (this.buckets.size <= this.pruneTarget) return;
    }

    // Still full: evict least-recently-used. This can forgive an offender, so
    // it is the last resort rather than the primary mechanism.
    for (const k of this.buckets.keys()) {
      this.buckets.delete(k);
      if (this.buckets.size <= this.pruneTarget) return;
    }
  }
}

const memoryLimiter = new MemoryTokenBucketLimiter();

// --- Upstash limiters ------------------------------------------------------

const upstashLimiters = new Map<string, Ratelimit>();

function upstashLimiter(
  redis: Redis,
  name: LimitName,
  scope: "p" | "i",
  quota: Quota,
): Ratelimit {
  const cacheKey = `${name}:${scope}:${quota.tokens}:${quota.windowSeconds}`;
  const existing = upstashLimiters.get(cacheKey);
  if (existing) return existing;

  const created = new Ratelimit({
    redis,
    // Sliding window rather than fixed: a fixed window lets 2x the quota
    // through across a window boundary, which on the claim limit is exactly
    // the burst a brute-forcer wants.
    limiter: Ratelimit.slidingWindow(
      quota.tokens,
      `${quota.windowSeconds} s` as Duration,
    ),
    prefix: `hunt:rl:${name}:${scope}`,
    analytics: false,
  });
  upstashLimiters.set(cacheKey, created);
  return created;
}

// --- Public API ------------------------------------------------------------

function normalizeIp(ip: string): string {
  const trimmed = ip.trim().toLowerCase();
  // An absent IP shares one bucket. That is deliberately harsh: it means a
  // deployment that fails to forward the client IP degrades to a global limit
  // instead of to no limit at all.
  return trimmed.length > 0 && trimmed.length <= 64 ? trimmed : "unknown";
}

function merge(a: LimitResult, b: LimitResult): LimitResult {
  return {
    ok: a.ok && b.ok,
    remaining: Math.min(a.remaining, b.remaining),
    resetAt: Math.max(a.resetAt, b.resetAt),
  };
}

function denied(quota: Quota, now: number): LimitResult {
  return { ok: false, remaining: 0, resetAt: now + quota.windowSeconds * 1000 };
}

/**
 * Consume one unit against `name` for the given caller.
 *
 * Keyed on BOTH playerId and ip, and BOTH must pass. Player-only keying lets
 * one host cycle wallets; IP-only keying punishes everyone behind a NAT for one
 * abuser. Requiring both means an attacker has to spread across hosts AND
 * identities to gain anything.
 */
export async function checkLimit(
  name: LimitName,
  key: { playerId?: string; ip: string },
): Promise<LimitResult> {
  const spec = LIMITS[name];
  if (!spec) {
    // Unknown limit name: reject. An accept here would mean a typo silently
    // removes a control.
    return { ok: false, remaining: 0, resetAt: Date.now() + 60_000 };
  }

  const ip = normalizeIp(key.ip);
  const playerId =
    typeof key.playerId === "string" && key.playerId.length > 0
      ? key.playerId
      : null;

  const redis = getRedis();
  const now = Date.now();

  if (redis) {
    try {
      const checks: Array<Promise<LimitResult>> = [
        upstashLimiter(redis, name, "i", spec.perIp)
          .limit(ip)
          .then((r) => ({
            ok: r.success,
            remaining: r.remaining,
            resetAt: r.reset,
          })),
      ];
      if (playerId && spec.perPlayer) {
        checks.push(
          upstashLimiter(redis, name, "p", spec.perPlayer)
            .limit(playerId)
            .then((r) => ({
              ok: r.success,
              remaining: r.remaining,
              resetAt: r.reset,
            })),
        );
      }
      const results = await Promise.all(checks);
      return results.reduce(merge);
    } catch {
      // Never log the error object: an Upstash error can carry the REST URL,
      // which embeds the database identifier.
      if (spec.failClosed) {
        console.error(`[ratelimit] backend error, denying ${name}`);
        return denied(spec.perIp, now);
      }
      console.error(`[ratelimit] backend error, degrading ${name} to memory`);
      // fall through to the in-memory limiter — degraded (per-instance) but
      // still a limit, which beats failing open.
    }
  }

  let result = memoryLimiter.take(`${name}:i:${ip}`, spec.perIp, now);
  if (playerId && spec.perPlayer) {
    result = merge(
      result,
      memoryLimiter.take(`${name}:p:${playerId}`, spec.perPlayer, now),
    );
  }
  return result;
}

/** Documented defaults, exported so the admin UI can display them. */
export function limitSpec(name: LimitName): Readonly<LimitSpec> {
  return LIMITS[name];
}

/** Test seam. Never called from application code. */
export function __resetLimiterState(): void {
  memoryLimiter.clear();
  upstashLimiters.clear();
  redisClient = null;
  redisResolved = false;
}

/** Test seam. Never called from application code. */
export function __memorySize(): number {
  return memoryLimiter.size;
}
