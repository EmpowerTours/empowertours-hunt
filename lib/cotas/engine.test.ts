import { describe, expect, it } from "vitest";
import {
  START_CHIPS,
  applySegment,
  centredWalls,
  checkWalls,
  clearWalls,
  followIfStranded,
  gapOf,
  leashLong,
  leashShort,
  newGame,
  openPnl,
  setWalls,
  step,
  type GameEvent,
  type GameState,
} from "./engine";

// Walls 0.40% apart around $0.01753: the width the backtest used.
const W = { lo: 17500, hi: 17570 };

function run(s: GameState, prices: number[]) {
  const events: GameEvent[] = [];
  for (const p of prices) {
    const r = step(s, p);
    s = r.state;
    events.push(...r.events);
  }
  return { s, events };
}

function armed(price = 17530): GameState {
  return setWalls(newGame(price), W, 1_000);
}

describe("walls", () => {
  it("measures the gap in tenths of a basis point", () => {
    expect(gapOf(W)).toBe(400);
    expect(leashLong(W)).toBe(17360); // 17500 - 2 x 0.40%
    expect(leashShort(W)).toBe(17711); // 17570 + 2 x 0.40%
  });

  it("refuses walls the price is not between, while flat", () => {
    const s = newGame(17600);
    expect(checkWalls(s, W, 1_000)).toEqual({
      ok: false,
      reason: "price_not_between",
    });
  });

  it("refuses a gap below 0.10% and above 2%", () => {
    const s = newGame(17530);
    expect(checkWalls(s, { lo: 17520, hi: 17530 + 5 }, 1_000)).toEqual({
      ok: false,
      reason: "gap_too_small",
    });
    expect(checkWalls(s, { lo: 17000, hi: 18000 }, 1_000)).toEqual({
      ok: false,
      reason: "gap_too_wide",
    });
  });

  it("refuses sizes outside the menu, non-integers and inverted walls", () => {
    const s = newGame(17530);
    expect(checkWalls(s, W, 750)).toEqual({ ok: false, reason: "bad_size" });
    expect(checkWalls(s, { lo: 17500.5, hi: 17570 }, 1_000)).toEqual({
      ok: false,
      reason: "bad_number",
    });
    expect(checkWalls(s, { lo: 17570, hi: 17500 }, 1_000)).toEqual({
      ok: false,
      reason: "inverted",
    });
  });

  it("refuses a size the chips cannot cover at 1x", () => {
    const s = { ...newGame(17530), balance: 50_000_000 }; // 50 chips
    expect(checkWalls(s, W, 5_000)).toEqual({
      ok: false,
      reason: "insufficient_chips",
    });
    expect(checkWalls(s, W, 1_000)).toEqual({ ok: true });
  });

  it("holding, only lets the exit move to the far side of the price", () => {
    const { s } = run(armed(), [17500]); // long from 17500
    expect(
      checkWalls({ ...s, last: 17540 }, { lo: 17500, hi: 17540 }, 1_000),
    ).toEqual({
      ok: false,
      reason: "exit_wrong_side",
    });
    expect(
      checkWalls({ ...s, last: 17540 }, { lo: 17500, hi: 17560 }, 1_000),
    ).toEqual({ ok: true });
  });

  it("keeps the size of an open trade when the walls move", () => {
    const { s } = run(armed(), [17500]);
    expect(setWalls(s, { lo: 17500, hi: 17580 }, 5_000).qty).toBe(1_000);
  });

  it("a size picked while holding closes the trade at the old size and opens the next at the new", () => {
    const held = run(armed(), [17500]).s;
    const picked = setWalls(held, W, 500);
    expect(picked.next).toBe(500);
    const { s, events } = run(picked, [17570, 17530, 17570]);
    const cross = events.find((e) => e.kind === "cross");
    const open = events.filter((e) => e.kind === "open");
    expect(cross && "qty" in cross && cross.qty).toBe(1_000);
    expect(open[0]).toMatchObject({ side: -1, qty: 500 });
    expect(s.qty).toBe(500);
    expect(s.next).toBeUndefined();
    // Picking the size already held clears a pending change.
    expect(setWalls(picked, W, 1_000).next).toBeUndefined();
  });

  it("will not take the walls down under an open trade", () => {
    const { s } = run(armed(), [17500]);
    expect(() => clearWalls(s)).toThrow();
  });
});

describe("a crossing", () => {
  it("long: opens at the bottom wall, closes at the top, pays two maker fees", () => {
    const { s, events } = run(armed(), [17520, 17500, 17540, 17570]);
    // open: 1,000 MON x 17500 x 2.9 bps = 5,075 micro-chips
    // close: gross 1,000 x 70 = 70,000; fee 1,000 x 17570 x 2.9 bps = 5,095.3 -> 5,095
    expect(events.map((e) => e.kind)).toEqual(["open", "cross"]);
    expect(events[1]).toMatchObject({
      kind: "cross",
      side: 1,
      price: 17570,
      entry: 17500,
      pnl: 64_905,
    });
    expect(s.balance).toBe(START_CHIPS - 5_075 + 64_905);
    expect(s.fees).toBe(5_075 + 5_095);
    expect(s).toMatchObject({ pos: 0, crossings: 1, streak: 1, armed: false });
  });

  it("short: opens at the top wall, closes at the bottom", () => {
    const { events } = run(armed(), [17575, 17540, 17495]);
    expect(events.map((e) => e.kind)).toEqual(["open", "cross"]);
    // fills at the walls, not at the trades that crossed them
    expect(events[0]).toMatchObject({ side: -1, price: 17570 });
    expect(events[1]).toMatchObject({
      side: -1,
      price: 17500,
      pnl: 70_000 - 5_075,
    });
  });

  it("does not re-open on the same wall until the price is back between the walls", () => {
    const { s, events } = run(armed(), [17500, 17570, 17580, 17570]);
    expect(events.map((e) => e.kind)).toEqual(["open", "cross"]);
    expect(s.armed).toBe(false);
    const after = run(s, [17540, 17570]);
    expect(after.events.map((e) => e.kind)).toEqual(["open"]);
    expect(after.s.pos).toBe(-1);
  });
});

describe("an escape", () => {
  it("long: the leash closes at the trade that crossed it, at taker fee, and re-centres", () => {
    const { s, events } = run(armed(), [17500, 17420, 17350]);
    // 1,000 x (17350 - 17500) = -150,000; fee 1,000 x 17350 x 8.9 bps = 15,441.5 -> 15,442
    expect(events.map((e) => e.kind)).toEqual(["open", "escape", "recenter"]);
    expect(events[1]).toMatchObject({ price: 17350, pnl: -165_442 });
    expect(s.balance).toBe(START_CHIPS - 5_075 - 165_442);
    expect(s.walls).toEqual(centredWalls(17350, 400));
    expect(s).toMatchObject({ pos: 0, escapes: 1, streak: 0, armed: true });
  });

  it("short: escapes upward through the top", () => {
    const { events } = run(armed(), [17570, 17720]);
    expect(events[1]).toMatchObject({ kind: "escape", side: -1, price: 17720 });
  });

  it("an escape breaks the streak but keeps the best one", () => {
    let { s } = run(armed(), [17500, 17570, 17540, 17500, 17570]);
    expect(s.streak).toBe(2);
    // back between the walls, long again from the bottom, then through the leash
    s = run(s, [17540, 17500, 17300]).s;
    expect(s.escapes).toBe(1);
    expect(s.streak).toBe(0);
    expect(s.bestStreak).toBe(2);
  });
});

describe("a minute that touched both sides", () => {
  it("holding long, counts the leash before the exit: never a free win", () => {
    const { s } = run(armed(), [17500]);
    const r = applySegment(s, { hi: 17600, lo: 17300, close: 17450 });
    expect(r.events.map((e) => e.kind)).toContain("escape");
    expect(r.events.map((e) => e.kind)).not.toContain("cross");
  });

  it("holding short, counts the high first", () => {
    const { s } = run(armed(), [17570]);
    const r = applySegment(s, { hi: 17800, lo: 17400, close: 17550 });
    expect(r.events[0]).toMatchObject({ kind: "escape", side: -1 });
  });
});

describe("stranded walls", () => {
  it("follow a price that ran past the leash while flat", () => {
    const s = { ...armed(), last: 17000 };
    const r = followIfStranded(s);
    expect(r.state.walls).toEqual(centredWalls(17000, 400));
    expect(r.events[0]).toMatchObject({ kind: "recenter", reason: "drift" });
  });

  it("stay put while a trade is open", () => {
    const { s } = run(armed(), [17500]);
    expect(followIfStranded({ ...s, last: 17000 }).events).toEqual([]);
  });
});

describe("chips", () => {
  it("a wall the chips cannot cover does not fill, and says so once", () => {
    const s = { ...armed(), balance: 1_000_000 }; // 1 chip
    const { s: after, events } = run(s, [17500, 17490, 17480]);
    expect(events).toEqual([
      { kind: "skip", reason: "insufficient_chips", price: 17500 },
    ]);
    expect(after.pos).toBe(0);
  });

  it("open P&L is marked but never booked into the balance", () => {
    const { s } = run(armed(), [17500]);
    expect(openPnl(s, 17540)).toBe(40_000);
    expect(s.balance).toBe(START_CHIPS - 5_075);
  });
});

describe("rejects garbage prices", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("%s", (p) => {
    expect(() => step(armed(), p)).toThrow();
  });
});

// Every micro-chip has to be accounted for: the balance is the start, plus every
// booked result, minus every opening fee. Run over a long seeded walk so a
// rounding leak anywhere would show up.
describe("the ledger balances", () => {
  it("over 20,000 random trades", () => {
    let seed = 42;
    const rand = () =>
      (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    let s = armed();
    let price = 17530;
    let booked = 0;
    let openFees = 0;
    for (let i = 0; i < 20_000; i++) {
      price = Math.max(1, price + Math.round((rand() - 0.5) * 40));
      const r = applySegment(s, {
        hi: price + Math.round(rand() * 15),
        lo: price - Math.round(rand() * 15),
        close: price,
      });
      s = r.state;
      for (const e of r.events) {
        if (e.kind === "open") openFees += e.fee;
        if (e.kind === "cross" || e.kind === "escape") booked += e.pnl;
      }
      expect(Number.isSafeInteger(s.balance)).toBe(true);
    }
    expect(s.crossings + s.escapes).toBeGreaterThan(100);
    expect(s.balance).toBe(START_CHIPS + booked - openFees);
  });
});
