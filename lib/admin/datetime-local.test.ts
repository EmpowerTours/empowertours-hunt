import { describe, expect, it } from "vitest";
import {
  fromLocalInput,
  toLocalInput,
  todayAtLocalHour,
} from "./datetime-local";

describe("round trip", () => {
  it("survives a there-and-back without drifting", () => {
    // Whatever the runner's timezone is, picking what the box shows and
    // storing it again must land on the same instant.
    const iso = new Date("2026-10-06T13:00:00.000Z").toISOString();
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
  });

  it("keeps empty empty, rather than turning it into 1970", () => {
    // A blank end date means "no end bound". Coercing it to epoch would
    // silently retire the hunt the moment it was saved.
    expect(toLocalInput("")).toBe("");
    expect(fromLocalInput("")).toBe("");
  });

  it("refuses a value it cannot parse instead of inventing one", () => {
    expect(toLocalInput("not a date")).toBe("");
    expect(fromLocalInput("not a date")).toBe("");
    expect(toLocalInput("2026-13-45T99:99")).toBe("");
  });
});

describe("the picker speaks local time", () => {
  it("reads a zoneless string as LOCAL, not as UTC", () => {
    // The bug this pins: treating "2026-10-06T21:00" as UTC. In Singapore that
    // would store 5am the next morning and the hunt would outlive the event by
    // eight hours; west of Greenwich it would expire before it started.
    const stored = fromLocalInput("2026-10-06T21:00");
    const back = new Date(stored);
    expect(back.getHours()).toBe(21);
    expect(back.getMinutes()).toBe(0);
  });
});

describe("todayAtLocalHour", () => {
  it("lands on the asked-for hour in local time", () => {
    const iso = todayAtLocalHour(21, new Date("2026-10-06T04:30:00.000Z"));
    const d = new Date(iso);
    expect(d.getHours()).toBe(21);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
  });

  it("uses today, not tomorrow", () => {
    const now = new Date();
    const d = new Date(todayAtLocalHour(21, now));
    expect(d.getDate()).toBe(now.getDate());
  });

  it("does not mutate the clock it was handed", () => {
    const now = new Date("2026-10-06T04:30:00.000Z");
    const before = now.getTime();
    todayAtLocalHour(21, now);
    expect(now.getTime()).toBe(before);
  });
});
