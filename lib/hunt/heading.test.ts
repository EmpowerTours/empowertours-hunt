import { describe, expect, it } from "vitest";
import {
  compassWord,
  headingFromEvent,
  screenAngle,
  shortestTurn,
} from "./heading";

describe("iOS reports a heading directly", () => {
  it("uses webkitCompassHeading as-is", () => {
    expect(headingFromEvent({ webkitCompassHeading: 0 })).toBe(0);
    expect(headingFromEvent({ webkitCompassHeading: 90 })).toBe(90);
    expect(headingFromEvent({ webkitCompassHeading: 271.5 })).toBe(271.5);
  });

  it("refuses a reading iOS says is uncalibrated", () => {
    // A negative accuracy is iOS saying the magnetometer cannot be trusted.
    // Rotating the scope by it would point confidently at nothing.
    expect(
      headingFromEvent({ webkitCompassHeading: 90, webkitCompassAccuracy: -1 }),
    ).toBeNull();
    expect(
      headingFromEvent({ webkitCompassHeading: 90, webkitCompassAccuracy: 15 }),
    ).toBe(90);
  });

  it("prefers iOS's heading over alpha when both are present", () => {
    // On iOS `alpha` is relative even when `absolute` looks set. Trusting it
    // there would silently mirror the scope on the platform most of these
    // players are holding.
    expect(
      headingFromEvent({
        webkitCompassHeading: 90,
        absolute: true,
        alpha: 123,
      }),
    ).toBe(90);
  });
});

describe("the standard event", () => {
  it("inverts alpha, because alpha counts anticlockwise", () => {
    // A device facing east reports alpha 270, not 90. Using alpha directly
    // mirrors the entire instrument — a bug that looks almost right.
    expect(headingFromEvent({ absolute: true, alpha: 0 })).toBe(0);
    expect(headingFromEvent({ absolute: true, alpha: 270 })).toBe(90);
    expect(headingFromEvent({ absolute: true, alpha: 90 })).toBe(270);
  });

  it("refuses a relative reading outright", () => {
    // Relative alpha is measured from wherever the phone happened to be
    // pointing when listening started. A scope rotated by it looks
    // authoritative and points somewhere arbitrary — worse than north-up.
    expect(headingFromEvent({ absolute: false, alpha: 90 })).toBeNull();
    expect(headingFromEvent({ alpha: 90 })).toBeNull();
  });

  it("refuses missing or non-finite alpha", () => {
    expect(headingFromEvent({ absolute: true })).toBeNull();
    expect(headingFromEvent({ absolute: true, alpha: null })).toBeNull();
    expect(headingFromEvent({ absolute: true, alpha: Number.NaN })).toBeNull();
  });

  it("returns null for an empty event rather than guessing north", () => {
    expect(headingFromEvent({})).toBeNull();
  });
});

describe("turning the short way", () => {
  it("crosses north without spinning backwards", () => {
    // 350 -> 10 is a 20 degree turn right, not 340 degrees left. Interpolating
    // raw degrees is the visual tell of a hand-rolled compass.
    expect(shortestTurn(350, 10)).toBe(20);
    expect(shortestTurn(10, 350)).toBe(-20);
  });

  it("handles the half turn and no turn", () => {
    expect(shortestTurn(0, 180)).toBe(180);
    expect(shortestTurn(90, 90)).toBe(0);
  });
});

describe("where a bearing draws on screen", () => {
  it("puts a spawn dead ahead at the top in heading-up mode", () => {
    // Facing north-east at a spawn to the north-east: straight up.
    expect(screenAngle(45, 45)).toBe(0);
    expect(screenAngle(200, 200)).toBe(0);
  });

  it("puts a spawn behind you at the bottom", () => {
    expect(screenAngle(180, 0)).toBe(180);
    expect(screenAngle(0, 180)).toBe(180);
  });

  it("wraps past north without going negative", () => {
    // Bearing 10 while facing 40 is 30 degrees to your LEFT, which is 330 on
    // screen — not -30, which would rotate an SVG the wrong way in some
    // renderers and is unreadable in a debug log.
    expect(screenAngle(10, 40)).toBe(330);
    expect(screenAngle(350, 10)).toBe(340);
  });

  it("uses the raw bearing when there is no heading", () => {
    // North-up fallback: the bearing IS the screen angle.
    expect(screenAngle(45, null)).toBe(45);
    expect(screenAngle(300, null)).toBe(300);
  });
});

describe("the direction in words", () => {
  it("calls straight ahead 'ahead', not 'ahead right'", () => {
    // The sectors are offset so 0 lands in the middle of "ahead" rather than
    // at its edge.
    expect(compassWord(0, "en")).toBe("ahead");
    expect(compassWord(20, "en")).toBe("ahead");
    expect(compassWord(340, "en")).toBe("ahead");
  });

  it("names the eight sectors in both languages", () => {
    expect(compassWord(90, "en")).toBe("right");
    expect(compassWord(270, "en")).toBe("left");
    expect(compassWord(180, "en")).toBe("behind");
    expect(compassWord(90, "es")).toBe("a la derecha");
    expect(compassWord(270, "es")).toBe("a la izquierda");
    expect(compassWord(0, "es")).toBe("al frente");
  });

  it("never falls off the end of the sector list", () => {
    for (let a = -720; a <= 720; a += 7) {
      expect(typeof compassWord(a, "en")).toBe("string");
      expect(compassWord(a, "en").length).toBeGreaterThan(0);
    }
  });
});
