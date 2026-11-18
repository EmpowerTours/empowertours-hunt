import { describe, expect, it } from "vitest";
import {
  apply,
  initialState,
  openRound,
  parseFrame,
  type ServerMsg,
  type WireRound,
} from "./chipboardState";
import {
  bandOf,
  baseline,
  defaultSpread,
  previewPoints,
  shares,
  sum,
} from "./chipboardMath";

const K = 90_000_000;
const edges = Array.from({ length: 11 }, (_, k) => 104_250 + (k - 5) * 25);
const round = (
  id: number,
  status: WireRound["status"] = "open",
): WireRound => ({
  id,
  open: id * 20_000,
  lock: id * 20_000 + 20_000,
  close: id * 20_000 + 80_000,
  status,
  openPrice: 104_250,
  sigma: 2,
  band: 25,
  centre: 104_250,
  edges,
  landed: -1,
});
const chipsAt = (band: number, n: number) => {
  const c = new Array(12).fill(0);
  c[band] = n;
  return c;
};

function run(msgs: ServerMsg[], now = K * 20_000) {
  const s = initialState();
  for (const m of msgs) apply(s, m, now);
  return s;
}

const hello = (rounds: Array<WireRound & { chips: number[] }>): ServerMsg => ({
  t: "hello",
  ts: K * 20_000,
  player: "p1",
  rule: "composite",
  rounds,
  qualifyRounds: 20,
  holdMs: 60_000,
  openMs: 20_000,
  day: "2026-11-18",
  trail: [
    [K * 20_000 - 2000, 104_240],
    [K * 20_000 - 1000, 104_245],
  ],
});

describe("parseFrame", () => {
  it("splits newline-separated messages and skips bad lines", () => {
    const f = '{"t":"px","ts":1,"p":2}\n{oops\n\n{"t":"pong","ts":3}';
    expect(parseFrame(f).map((m) => m.t)).toEqual(["px", "pong"]);
  });
});

describe("apply", () => {
  it("takes rounds, chips, trail and standing from hello", () => {
    const s = run([
      {
        ...hello([{ ...round(K), chips: chipsAt(6, 40) }]),
        standing: {
          day: "2026-11-18",
          points: 12,
          rounds: 3,
          rank: 2,
          players: 9,
          qualified: false,
          qualifyRounds: 20,
        },
      } as ServerMsg,
    ]);
    expect(s.player).toBe("p1");
    expect(s.rounds[0].chips[6]).toBe(40);
    expect(s.rounds[0].confirmed[6]).toBe(40);
    expect(s.px).toHaveLength(2);
    expect(s.standing?.rank).toBe(2);
    expect(openRound(s, K * 20_000 + 1)?.id).toBe(K);
    expect(openRound(s, K * 20_000 + 20_000)).toBeNull();
  });

  it("keeps optimistic chips until the newest ack, and reverts on refusal", () => {
    const s = run([hello([{ ...round(K), chips: chipsAt(6, 0) }])]);
    const r = s.rounds[0];
    r.chips = chipsAt(6, 10);
    r.lastSent = 1;
    r.chips = chipsAt(6, 20);
    r.lastSent = 2;
    apply(s, { t: "ack", id: 1, ok: true, round: K, chips: chipsAt(6, 10) }, 0);
    expect(r.confirmed[6]).toBe(10);
    expect(r.chips[6]).toBe(20); // id 2 still in flight
    apply(
      s,
      { t: "ack", id: 2, ok: false, reason: "round_locked", round: K },
      5,
    );
    expect(r.chips[6]).toBe(10);
    expect(s.refusal).toEqual({ reason: "round_locked", at: 5 });
  });

  it("follows a round through lock, close and the server's result", () => {
    const s = run([hello([{ ...round(K), chips: chipsAt(6, 100) }])]);
    const base = baseline(edges, 104_250, 2 * Math.sqrt(60));
    apply(s, { t: "lock", round: K, lockPrice: 104_250, baseline: base }, 0);
    apply(s, { t: "open", round: round(K + 1) }, 0);
    expect(s.rounds.map((r) => [r.id, r.status])).toEqual([
      [K, "locked"],
      [K + 1, "open"],
    ]);
    apply(
      s,
      { t: "close", round: K, rule: "composite", price: 104_260, band: 6 },
      1,
    );
    apply(
      s,
      {
        t: "result",
        round: K,
        price: 104_260,
        band: 6,
        chips: chipsAt(6, 100),
        placed: 100,
        points: 71,
      },
      1,
    );
    expect(s.rounds[0].status).toBe("settled");
    expect(s.history[0]).toMatchObject({ round: K, points: 71, landed: 6 });
    // The points shown are the server's, whatever the preview math says.
    expect(s.toast).toMatchObject({ kind: "win", points: 71 });
    expect(s.closes).toBe(1);
  });

  it("records a void round the player had chips on", () => {
    const s = run([hello([{ ...round(K, "locked"), chips: chipsAt(3, 30) }])]);
    apply(s, { t: "void", round: K, phase: "close", reason: "divergence" }, 9);
    expect(s.rounds[0].status).toBe("void");
    expect(s.history[0]).toMatchObject({ round: K, voidReason: "divergence" });
    expect(s.toast?.kind).toBe("void");
    // A void round with no chips of ours is not news.
    const t = run([hello([{ ...round(K), chips: chipsAt(3, 0) }])]);
    apply(t, { t: "void", round: K, phase: "lock", reason: "perpl_stale" }, 9);
    expect(t.history).toHaveLength(0);
    expect(t.toast).toBeNull();
  });
});

describe("preview math", () => {
  const base = baseline(edges, 104_250, 15);
  it("baseline sums to 1 and bands are closed below", () => {
    expect(sum(base)).toBeCloseTo(1, 9);
    expect(bandOf(edges, edges[0] - 0.01)).toBe(0);
    expect(bandOf(edges, edges[0])).toBe(1);
    expect(bandOf(edges, edges[10])).toBe(11);
    expect(bandOf(edges, 104_250)).toBe(6);
  });
  it("chips in hand follow the baseline, so no chips previews 0 everywhere", () => {
    const q = shares(new Array(12).fill(0), base);
    q.forEach((x, i) => expect(x).toBeCloseTo(base[i], 12));
    for (let k = 0; k < 12; k++)
      expect(previewPoints(new Array(12).fill(0), base, k)).toBe(0);
  });
  it("default spread places exactly 100 chips", () => {
    expect(sum(defaultSpread(base))).toBe(100);
  });
});
