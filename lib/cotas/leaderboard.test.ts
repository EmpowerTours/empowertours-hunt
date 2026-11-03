import { describe, expect, it } from "vitest";
import {
  MIN_CROSSINGS,
  rank,
  validAlias,
  weekStart,
  type Tally,
} from "./leaderboard";

const t = (
  alias: string,
  net: number,
  crossings: number,
  escapes = 0,
  capital = 1_000_000_000,
): Tally => ({
  playerId: alias,
  alias,
  net,
  crossings,
  escapes,
  capital,
});

describe("weekStart (Monday 00:00 Mexico City, fixed UTC-6)", () => {
  it("a Wednesday maps back to Monday 06:00 UTC", () => {
    expect(
      new Date(weekStart(Date.parse("2026-11-04T15:00:00Z"))).toISOString(),
    ).toBe("2026-11-02T06:00:00.000Z");
  });

  it("Monday 05:59 UTC is still Sunday in Mexico City: the previous week", () => {
    expect(
      new Date(weekStart(Date.parse("2026-11-02T05:59:00Z"))).toISOString(),
    ).toBe("2026-10-26T06:00:00.000Z");
  });

  it("Monday 06:00 UTC starts the new week", () => {
    expect(
      new Date(weekStart(Date.parse("2026-11-02T06:00:00Z"))).toISOString(),
    ).toBe("2026-11-02T06:00:00.000Z");
  });
});

describe("rank", () => {
  it("orders by return, not by volume", () => {
    const board = rank([
      t("busy", 10_000_000, 200, 50), // +1% on lots of trading
      t("sharp", 50_000_000, 12, 1), // +5% on few
    ]);
    expect(board.map((r) => r.alias)).toEqual(["sharp", "busy"]);
    expect(board[0]).toMatchObject({ rank: 1, ret: 0.05 });
  });

  it("is size-blind: the same return on ten times the capital ranks the same", () => {
    const board = rank([
      t("big", 500_000_000, 20, 5, 10_000_000_000),
      t("small", 50_000_000, 20, 5, 1_000_000_000),
    ]);
    expect(board[0].ret).toBe(board[1].ret);
  });

  it(`needs ${MIN_CROSSINGS} crossings to qualify`, () => {
    expect(rank([t("lucky", 900_000_000, MIN_CROSSINGS - 1)])).toEqual([]);
    expect(rank([t("enough", 1, MIN_CROSSINGS)])).toHaveLength(1);
  });

  it("breaks ties on hit rate", () => {
    const board = rank([
      t("loose", 20_000_000, 10, 10),
      t("tight", 20_000_000, 10, 2),
    ]);
    expect(board.map((r) => r.alias)).toEqual(["tight", "loose"]);
  });
});

describe("alias", () => {
  it.each(["abc", "Rocket_99", "A1234567890bcdef"])("accepts %s", (a) =>
    expect(validAlias(a)).toBe(true),
  );
  it.each(["ab", "has space", "x".repeat(17), "<script>", "ñandu", 42, null])(
    "rejects %s",
    (a) => expect(validAlias(a)).toBe(false),
  );
});
