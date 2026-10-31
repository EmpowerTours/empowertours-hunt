import { describe, expect, it, vi } from "vitest";
import { chooseRoute, runAusdSwap, type AusdRunners } from "./ausd-route";

const H = "0xabc" as const;

describe("chooseRoute", () => {
  it("takes whichever pays more — today's 843 MON quotes pick v4", () => {
    // 2026-10-31: v4 16.199674 AUSD, desk 16.155010.
    expect(chooseRoute({ v4: 16_199_674n, desk: 16_155_010n, deskAvailable: 103_000_000n }))
      .toEqual({ route: "v4", ausdOut: 16_199_674n });
  });
  it("takes the desk when it pays more", () => {
    expect(chooseRoute({ v4: 15_000_000n, desk: 16_000_000n, deskAvailable: 103_000_000n })?.route).toBe("desk");
  });
  it("gives a tie to v4 — a desk fill spends AUSD we replace by hand", () => {
    expect(chooseRoute({ v4: 5n, desk: 5n, deskAvailable: 100n })?.route).toBe("v4");
  });
  it("never picks a desk whose float cannot cover the quote", () => {
    expect(chooseRoute({ v4: 10n, desk: 20n, deskAvailable: 19n })?.route).toBe("v4");
  });
  it("is null when neither can fill", () => {
    expect(chooseRoute({ v4: null, desk: 20n, deskAvailable: 19n })).toBeNull();
    expect(chooseRoute({ v4: 0n, desk: null, deskAvailable: null })).toBeNull();
  });
});

const runners = (over: Partial<AusdRunners>): AusdRunners => ({
  quote: vi.fn(async () => ({ v4: 10n, desk: 20n, deskAvailable: 100n })),
  v4: vi.fn(async (s) => { s(H); return { hash: H, ausdOut: 10n }; }),
  desk: vi.fn(async (s) => { s(H); return { hash: H, ausdOut: 20n }; }),
  ...over,
});

describe("runAusdSwap", () => {
  it("runs the chosen route only", async () => {
    const r = runners({});
    expect((await runAusdSwap(1n, r)).route).toBe("desk");
    expect(r.v4).not.toHaveBeenCalled();
  });

  it("falls back to v4 when the desk refuses before sending (its per-address cap)", async () => {
    const r = runners({ desk: vi.fn(async () => { throw new Error("address cap"); }) });
    const out = await runAusdSwap(1n, r);
    expect(out.route).toBe("v4");
  });

  it("does NOT fall back after a desk swap was sent — it already cost gas", async () => {
    const r = runners({ desk: vi.fn(async (s) => { s(H); throw new Error("reverted"); }) });
    await expect(runAusdSwap(1n, r)).rejects.toThrow("reverted");
    expect(r.v4).not.toHaveBeenCalled();
  });

  it("does not fall back when v4 has no quote either", async () => {
    const quote = vi.fn()
      .mockResolvedValueOnce({ v4: 10n, desk: 20n, deskAvailable: 100n })
      .mockResolvedValueOnce({ v4: null, desk: 20n, deskAvailable: 100n });
    const r = runners({ quote, desk: vi.fn(async () => { throw new Error("address cap"); }) });
    await expect(runAusdSwap(1n, r)).rejects.toThrow("address cap");
    expect(r.v4).not.toHaveBeenCalled();
  });

  it("never retries v4 on its own failure", async () => {
    const r = runners({
      quote: vi.fn(async () => ({ v4: 30n, desk: 20n, deskAvailable: 100n })),
      v4: vi.fn(async () => { throw new Error("slippage"); }),
    });
    await expect(runAusdSwap(1n, r)).rejects.toThrow("slippage");
    expect(r.desk).not.toHaveBeenCalled();
  });

  it("says so when nothing can fill", async () => {
    const r = runners({ quote: vi.fn(async () => ({ v4: null, desk: null, deskAvailable: null })) });
    await expect(runAusdSwap(1n, r)).rejects.toThrow(/Neither/);
  });
});
