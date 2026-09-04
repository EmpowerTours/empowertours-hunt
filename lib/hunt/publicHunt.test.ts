import { describe, expect, it } from "vitest";
import {
  PUBLIC_HUNT_SELECT,
  creditSurveyors,
  isListable,
  remainingFinds,
  toPublicHunt,
  type PublicHuntRow,
} from "./publicHunt";

const NOW = new Date("2026-09-02T12:00:00Z");

function row(over: Partial<PublicHuntRow> = {}): PublicHuntRow {
  return {
    id: "h1",
    name: "Tierra Colorada, centro",
    description: null,
    active: true,
    startsAt: null,
    endsAt: null,
    maxAccuracyM: 30,
    cooldownSeconds: 60,
    spawnEnabled: false,
    spawnMaxRadiusM: 600,
    ...over,
  };
}

describe("the public payload cannot carry cache locations", () => {
  it("selects no cache relation and no coordinates", () => {
    // Structural, not a reminder: every public read uses this one select, so a
    // field added here is the only way a location could ever leak — and it
    // would be visible in this test's expected list.
    expect(Object.keys(PUBLIC_HUNT_SELECT).sort()).toEqual([
      "active",
      "cooldownSeconds",
      "description",
      "endsAt",
      "id",
      "maxAccuracyM",
      "name",
      "spawnEnabled",
      "spawnMaxRadiusM",
      "startsAt",
    ]);
  });

  it("serialises nothing beyond the contract", () => {
    const json = toPublicHunt(row());
    for (const key of Object.keys(json)) {
      expect([
        "lat",
        "lng",
        "caches",
        "cacheCount",
        "center",
        "bounds",
      ]).not.toContain(key);
    }
  });
});

describe("what a browser is shown", () => {
  it("hides an inactive hunt", () => {
    expect(isListable(row({ active: false }), NOW)).toBe(false);
  });

  it("hides a hunt that has ended", () => {
    expect(
      isListable(row({ endsAt: new Date("2026-09-01T00:00:00Z") }), NOW),
    ).toBe(false);
  });

  it("SHOWS a hunt that has not started yet", () => {
    // A hunt opening on Friday is the most useful thing a browser can learn,
    // and hiding it leaves the list empty on exactly the days a campaign is
    // driving people to it.
    expect(
      isListable(row({ startsAt: new Date("2026-09-05T00:00:00Z") }), NOW),
    ).toBe(true);
  });

  it("shows an open-ended active hunt", () => {
    expect(isListable(row(), NOW)).toBe(true);
  });

  it("treats an endsAt in this same second as still running", () => {
    expect(isListable(row({ endsAt: NOW }), NOW)).toBe(true);
  });
});

describe("remaining finds", () => {
  it("is omitted entirely when there is no cap", () => {
    // Not zero, and not a large number somebody might render as a countdown:
    // "no cap" and "none left" must not look the same on screen.
    expect(remainingFinds(0, 5)).toBeUndefined();
  });

  it("counts down and floors at zero", () => {
    expect(remainingFinds(10, 0)).toBe(10);
    expect(remainingFinds(10, 7)).toBe(3);
    expect(remainingFinds(10, 10)).toBe(0);
    expect(remainingFinds(10, 99)).toBe(0);
  });
});

describe("serialisation", () => {
  it("omits `remaining` for an anonymous reader", () => {
    // The client's parser reads a missing field as unknown and a number as
    // known. An anonymous browser genuinely has no remaining count.
    expect("remaining" in toPublicHunt(row())).toBe(false);
    expect(toPublicHunt(row(), 4).remaining).toBe(4);
  });

  it("emits dates as ISO strings or null", () => {
    const json = toPublicHunt(
      row({
        startsAt: new Date("2026-09-05T00:00:00Z"),
        endsAt: null,
      }),
    );
    expect(json.startsAt).toBe("2026-09-05T00:00:00.000Z");
    expect(json.endsAt).toBeNull();
  });
});

describe("crediting surveyors", () => {
  const walked = (displayName: string | null) => ({
    source: "WALKED",
    surveyedBy: displayName === null ? null : { displayName },
  });

  it("credits a walked survey", () => {
    expect(creditSurveyors([walked("Ana"), walked("Ana"), walked("Beto")])).toEqual([
      { displayName: "Ana", zones: 2 },
      { displayName: "Beto", zones: 1 },
    ]);
  });

  it("credits NOBODY for an OSM import", () => {
    // The distinction the whole feature rests on. An OSM ring is two
    // coordinates typed into a script — crediting it would make the credit
    // meaningless the first time anyone noticed, and paying for it would be
    // worse than meaningless.
    const imported = [
      { source: "OSM", surveyedBy: { displayName: "Ana" } },
      { source: "OSM", surveyedBy: null },
    ];
    expect(creditSurveyors(imported)).toEqual([]);
  });

  it("does not credit an admin-drawn ring", () => {
    expect(
      creditSurveyors([{ source: "ADMIN", surveyedBy: { displayName: "Ana" } }]),
    ).toEqual([]);
  });

  it("drops a surveyor who set no display name", () => {
    // Never an address. Publishing "this wallet surveyed this street",
    // permanently and to anybody, is not something somebody agreed to by
    // walking a boundary. A displayName is a deliberate act; an address is
    // just how they logged in.
    expect(creditSurveyors([walked(null), walked("")])).toEqual([]);
  });

  it("orders by contribution, most first", () => {
    const zones = [walked("Ana"), walked("Beto"), walked("Beto"), walked("Beto")];
    expect(creditSurveyors(zones).map((s) => s.displayName)).toEqual([
      "Beto",
      "Ana",
    ]);
  });

  it("is omitted from the payload entirely when nobody is credited", () => {
    // Not an empty array: the client treats a missing field as "no surveyors"
    // and would otherwise render an empty "Surveyed by" heading.
    const json = toPublicHunt(row(), undefined, []);
    expect("surveyors" in json).toBe(false);
  });
});
