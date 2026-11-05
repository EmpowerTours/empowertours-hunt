import { describe, expect, it } from "vitest";
import { MIN_MATCHES, rank, validAlias, weekStart, type Tally } from "./board";

const t = (
  alias: string,
  points: number,
  matches: number,
  wins = 0,
): Tally => ({
  playerId: alias,
  alias,
  matches,
  wins,
  points,
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
  it("orders by points per match, not by total", () => {
    const board = rank([
      t("busy", 400, 20), // 20 per match over many matches
      t("sharp", 150, 3), // 50 per match
    ]);
    expect(board.map((r) => r.alias)).toEqual(["sharp", "busy"]);
    expect(board[0]).toMatchObject({ rank: 1, avg: 50 });
  });

  it(`needs ${MIN_MATCHES} finished matches to qualify`, () => {
    expect(rank([t("lucky", 900, MIN_MATCHES - 1)])).toEqual([]);
    expect(rank([t("enough", 1, MIN_MATCHES)])).toHaveLength(1);
  });

  it("breaks ties on wins", () => {
    const board = rank([t("even", 60, 3, 1), t("steady", 60, 3, 2)]);
    expect(board.map((r) => r.alias)).toEqual(["steady", "even"]);
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
