import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  MemoryTokenBucketLimiter,
  checkLimit,
  limitSpec,
  __memorySize,
  __resetLimiterState,
} from "./ratelimit";

const QUOTA = { tokens: 5, windowSeconds: 60 };

beforeEach(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  __resetLimiterState();
});

afterEach(() => {
  __resetLimiterState();
});

describe("MemoryTokenBucketLimiter", () => {
  it("allows exactly the quota then blocks", () => {
    const limiter = new MemoryTokenBucketLimiter();
    const now = 1_000_000;

    for (let i = 0; i < QUOTA.tokens; i += 1) {
      expect(limiter.take("k", QUOTA, now).ok).toBe(true);
    }
    expect(limiter.take("k", QUOTA, now).ok).toBe(false);
  });

  it("reports remaining counting down to zero", () => {
    const limiter = new MemoryTokenBucketLimiter();
    const now = 1_000_000;

    expect(limiter.take("k", QUOTA, now).remaining).toBe(4);
    expect(limiter.take("k", QUOTA, now).remaining).toBe(3);
    expect(limiter.take("k", QUOTA, now).remaining).toBe(2);
  });

  it("refills over time", () => {
    const limiter = new MemoryTokenBucketLimiter();
    const start = 1_000_000;
    for (let i = 0; i < QUOTA.tokens; i += 1) limiter.take("k", QUOTA, start);
    expect(limiter.take("k", QUOTA, start).ok).toBe(false);

    // One token per window/tokens = 12s.
    expect(limiter.take("k", QUOTA, start + 11_999).ok).toBe(false);
    expect(limiter.take("k", QUOTA, start + 12_000).ok).toBe(true);
  });

  it("never refills past capacity", () => {
    const limiter = new MemoryTokenBucketLimiter();
    const start = 1_000_000;
    limiter.take("k", QUOTA, start);

    // A week idle must not bank a week of tokens.
    const later = start + 7 * 24 * 3600 * 1000;
    for (let i = 0; i < QUOTA.tokens; i += 1) {
      expect(limiter.take("k", QUOTA, later).ok).toBe(true);
    }
    expect(limiter.take("k", QUOTA, later).ok).toBe(false);
  });

  it("resetAt tells a blocked caller when one token returns", () => {
    const limiter = new MemoryTokenBucketLimiter();
    const start = 1_000_000;
    for (let i = 0; i < QUOTA.tokens; i += 1) limiter.take("k", QUOTA, start);

    const blocked = limiter.take("k", QUOTA, start);
    expect(blocked.ok).toBe(false);
    expect(blocked.resetAt).toBe(start + 12_000);
  });

  // --- M1 regression -------------------------------------------------------
  //
  // The replaced implementation pushed a timestamp on EVERY call, including
  // calls it had already blocked. An attacker ignoring the 429 grew the array
  // without bound inside the window and every later request re-filtered the
  // whole thing, so cost per request scaled with the attacker's own volume.
  // These two tests fail against that behaviour and pass against a token
  // bucket.

  it("M1: a blocked caller accumulates no state", () => {
    const limiter = new MemoryTokenBucketLimiter();
    const now = 1_000_000;
    for (let i = 0; i < QUOTA.tokens; i += 1) limiter.take("k", QUOTA, now);

    let anyAllowed = false;
    for (let i = 0; i < 60_000; i += 1) {
      if (limiter.take("k", QUOTA, now).ok) anyAllowed = true;
    }

    expect(anyAllowed).toBe(false);
    // One bucket, two numbers. The old code held ~60k timestamps here.
    expect(limiter.size).toBe(1);
  });

  it("M1: 60k blocked requests stay cheap (no quadratic re-scan)", () => {
    const limiter = new MemoryTokenBucketLimiter();
    const now = 1_000_000;
    for (let i = 0; i < QUOTA.tokens; i += 1) limiter.take("k", QUOTA, now);

    const started = Date.now();
    for (let i = 0; i < 60_000; i += 1) limiter.take("k", QUOTA, now);
    const elapsed = Date.now() - started;

    // O(1) per call finishes in single-digit ms. The generous bound keeps this
    // from being flaky on a loaded CI box while still failing loudly against an
    // O(n^2) implementation, which took seconds at this volume.
    expect(elapsed).toBeLessThan(2_000);
  });

  it("caps the map so distinct keys cannot leak memory", () => {
    const limiter = new MemoryTokenBucketLimiter(500);
    for (let i = 0; i < 20_000; i += 1) {
      limiter.take(`ip-${i}`, QUOTA, 1_000_000 + i);
    }
    expect(limiter.size).toBeLessThanOrEqual(500);
  });

  it("evicts refilled keys before ones still paying off a burst", () => {
    // Pressure on the map must not forgive an offender, or an attacker gets a
    // reset by flooding the limiter with junk keys.
    const limiter = new MemoryTokenBucketLimiter(20);
    const t0 = 1_000_000;

    // An offender, fully drained: 60s of debt.
    for (let i = 0; i < QUOTA.tokens; i += 1) limiter.take("bad", QUOTA, t0);
    expect(limiter.take("bad", QUOTA, t0).ok).toBe(false);

    // Keys that spend a single token — 12s of debt — and then go quiet.
    for (let i = 0; i < 14; i += 1) limiter.take(`idle-${i}`, QUOTA, t0);

    // 20s on, the one-token keys have refilled to capacity and are therefore
    // indistinguishable from callers we have never seen; the offender has
    // recovered only ~1.6 tokens. Filling the map forces a prune here.
    const t1 = t0 + 20_000;
    for (let i = 0; i < 10; i += 1) limiter.take(`new-${i}`, QUOTA, t1);

    // The offender survived with its debt intact: one token, not a fresh five.
    expect(limiter.take("bad", QUOTA, t1).ok).toBe(true);
    expect(limiter.take("bad", QUOTA, t1).ok).toBe(false);
  });

  it("does not carry stale tokens across a quota change", () => {
    const limiter = new MemoryTokenBucketLimiter();
    const now = 1_000_000;
    limiter.take("k", { tokens: 100, windowSeconds: 60 }, now);

    // Same key, much tighter quota. The old bucket must be clamped, not trusted.
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.take("k", QUOTA, now).ok).toBe(true);
    }
    expect(limiter.take("k", QUOTA, now).ok).toBe(false);
  });
});

describe("checkLimit", () => {
  it("limits by IP even with no playerId", async () => {
    const ip = "203.0.113.9";
    const spec = limitSpec("claim");

    for (let i = 0; i < spec.perIp.tokens; i += 1) {
      expect((await checkLimit("claim", { ip })).ok).toBe(true);
    }
    expect((await checkLimit("claim", { ip })).ok).toBe(false);
  });

  it("limits by playerId even when the IP rotates", async () => {
    // A player behind a rotating proxy still has one identity, and the claim
    // limit is what makes coordinate brute-forcing expensive.
    const playerId = "player_1";
    const spec = limitSpec("claim");

    for (let i = 0; i < spec.perPlayer!.tokens; i += 1) {
      const r = await checkLimit("claim", { playerId, ip: `198.51.100.${i}` });
      expect(r.ok).toBe(true);
    }

    const blocked = await checkLimit("claim", {
      playerId,
      ip: "198.51.100.250",
    });
    expect(blocked.ok).toBe(false);
  });

  it("does not let one player's block spill onto another", async () => {
    const spec = limitSpec("claim");
    for (let i = 0; i < spec.perPlayer!.tokens + 3; i += 1) {
      await checkLimit("claim", { playerId: "noisy", ip: `192.0.2.${i}` });
    }

    const other = await checkLimit("claim", {
      playerId: "quiet",
      ip: "192.0.2.200",
    });
    expect(other.ok).toBe(true);
  });

  it("keeps the claim limit strict — it is the anti-brute-force control", () => {
    const spec = limitSpec("claim");
    expect(spec.perPlayer!.tokens).toBeLessThanOrEqual(10);
    expect(spec.perPlayer!.windowSeconds).toBeGreaterThanOrEqual(60);
    expect(spec.failClosed).toBe(true);
  });

  it("fails closed on the money paths", () => {
    expect(limitSpec("claim").failClosed).toBe(true);
    expect(limitSpec("spawn").failClosed).toBe(true);
    expect(limitSpec("register").failClosed).toBe(true);
  });

  it("shares one bucket when the IP is missing rather than skipping the limit", async () => {
    const spec = limitSpec("hint");
    for (let i = 0; i < spec.perIp.tokens; i += 1) {
      expect((await checkLimit("hint", { ip: "" })).ok).toBe(true);
    }
    expect((await checkLimit("hint", { ip: "   " })).ok).toBe(false);
  });

  it("rejects an unknown limit name instead of allowing it", async () => {
    const result = await checkLimit("not_a_limit" as unknown as "claim", {
      ip: "203.0.113.1",
    });
    expect(result.ok).toBe(false);
  });

  it("keeps the in-memory map bounded across many distinct callers", async () => {
    for (let i = 0; i < 30_000; i += 1) {
      await checkLimit("hint", { ip: `10.0.${(i >> 8) & 255}.${i & 255}` });
    }
    expect(__memorySize()).toBeLessThanOrEqual(20_000);
  });
});
