import { describe, it, expect, vi } from "vitest";
import {
  isRetryableTransactionError,
  withTransactionRetry,
  SerializationExhausted,
  RETRYABLE_SQLSTATES,
} from "./retry";

// The real error shapes, copied from a live Postgres 16 under contention rather
// than imagined. `meta.code` is where a $executeRaw failure carries its
// SQLSTATE, and getting that wrong is what produced the 500s in the first
// place.
const p2010 = (sqlstate: string) => ({
  name: "PrismaClientKnownRequestError",
  code: "P2010",
  meta: { code: sqlstate, message: "could not serialize access" },
});

describe("isRetryableTransactionError", () => {
  it("recognises a serialization failure behind P2010", () => {
    expect(isRetryableTransactionError(p2010("40001"))).toBe(true);
  });

  it("recognises a deadlock behind P2010", () => {
    expect(isRetryableTransactionError(p2010("40P01"))).toBe(true);
  });

  it("recognises Prisma's own write-conflict code", () => {
    expect(isRetryableTransactionError({ code: "P2034" })).toBe(true);
  });

  it("recognises a bare driver error carrying the SQLSTATE itself", () => {
    expect(isRetryableTransactionError({ code: "40001" })).toBe(true);
  });

  // Reject-by-default. Each of these means "this will fail the same way
  // forever", and retrying turns one refusal into four.
  it.each([
    ["a unique violation", { code: "P2002" }],
    ["a check constraint", { code: "P2010", meta: { code: "23514" } }],
    ["a foreign key", { code: "P2003" }],
    ["P2010 with no meta at all", { code: "P2010" }],
    ["P2010 with a non-string meta code", { code: "P2010", meta: { code: 40001 } }],
    ["a plain Error", new Error("boom")],
    ["null", null],
    ["undefined", undefined],
    ["a string", "40001"],
    ["an object with no code", {}],
  ])("does not retry %s", (_label, error) => {
    expect(isRetryableTransactionError(error)).toBe(false);
  });

  it("lists only the two states that mean nothing committed", () => {
    // A guard on the set itself: adding anything here makes a failure retry,
    // and the wrong entry retries something that already happened.
    expect([...RETRYABLE_SQLSTATES].sort()).toEqual(["40001", "40P01"]);
  });
});

describe("withTransactionRetry", () => {
  const noSleep = () => Promise.resolve();

  it("returns the first success without sleeping", async () => {
    const sleep = vi.fn(noSleep);
    const op = vi.fn().mockResolvedValue("ok");

    await expect(withTransactionRetry(op, { sleep })).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a serialization failure and returns the eventual success", async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(p2010("40001"))
      .mockRejectedValueOnce(p2010("40001"))
      .mockResolvedValue("committed");

    await expect(withTransactionRetry(op, { sleep: noSleep })).resolves.toBe(
      "committed",
    );
    expect(op).toHaveBeenCalledTimes(3);
  });

  it("rethrows a non-retryable failure immediately", async () => {
    // The case that matters most: a ceiling refusing must reach the caller as
    // itself, on the first attempt, not four attempts later wearing a
    // different error's name.
    const rejected = Object.assign(new Error("hunt_budget_exhausted"), {
      code: "P2002",
    });
    const op = vi.fn().mockRejectedValue(rejected);

    await expect(withTransactionRetry(op, { sleep: noSleep })).rejects.toBe(
      rejected,
    );
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("gives up after the configured number of attempts", async () => {
    const op = vi.fn().mockRejectedValue(p2010("40001"));

    await expect(
      withTransactionRetry(op, { attempts: 3, sleep: noSleep }),
    ).rejects.toBeInstanceOf(SerializationExhausted);
    expect(op).toHaveBeenCalledTimes(3);
  });

  it("carries the attempt count and the last error when it gives up", async () => {
    const last = p2010("40P01");
    const op = vi.fn().mockRejectedValue(last);

    const thrown = await withTransactionRetry(op, {
      attempts: 2,
      sleep: noSleep,
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(thrown).toBeInstanceOf(SerializationExhausted);
    // The route files an audit row from these, so they have to be real.
    expect((thrown as SerializationExhausted).attempts).toBe(2);
    expect((thrown as SerializationExhausted).lastError).toBe(last);
  });

  it("backs off with FULL jitter, doubling the ceiling and capping it", async () => {
    // random() pinned to 1 reads the ceiling straight out, which is what makes
    // the schedule assertable at all.
    const delays: number[] = [];
    const op = vi.fn().mockRejectedValue(p2010("40001"));

    await withTransactionRetry(op, {
      attempts: 5,
      baseDelayMs: 20,
      maxDelayMs: 60,
      random: () => 1,
      sleep: async (ms) => {
        delays.push(ms);
      },
    }).catch(() => {});

    // 20, 40, then capped at 60 — never 80. An uncapped schedule turns
    // contention into latency nobody bounded.
    expect(delays).toEqual([20, 40, 60, 60]);
  });

  it("spreads retries out instead of recreating the collision", async () => {
    // These transactions collided because they arrived together. A fixed
    // backoff sends them back together and they collide again; full jitter is
    // the entire reason the sleep helps.
    const delays: number[] = [];
    const randoms = [0, 0.5, 1];
    let i = 0;

    await withTransactionRetry(vi.fn().mockRejectedValue(p2010("40001")), {
      attempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      random: () => randoms[i++],
      sleep: async (ms) => {
        delays.push(ms);
      },
    }).catch(() => {});

    expect(delays).toEqual([0, 100, 400]);
    expect(new Set(delays).size).toBe(delays.length);
  });

  it("reports each retry so contention is visible to operations", async () => {
    const onRetry = vi.fn();
    await withTransactionRetry(vi.fn().mockRejectedValue(p2010("40001")), {
      attempts: 3,
      sleep: noSleep,
      random: () => 0,
      onRetry,
    }).catch(() => {});

    // Two retries between three attempts. A silent retry loop hides the load
    // that caused it, which is the thing an operator needs to see.
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0]).toBe(1);
  });

  it("refuses a nonsensical attempt count rather than looping oddly", async () => {
    await expect(
      withTransactionRetry(vi.fn(), { attempts: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
