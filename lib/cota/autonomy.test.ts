import { describe, expect, it } from "vitest";
import {
  agentMay,
  AUTONOMY_MODES,
  isAutonomyMode,
  parseAutonomy,
} from "./autonomy";

describe("parseAutonomy fails closed", () => {
  it("reads the two real grants", () => {
    expect(parseAutonomy("exit_only")).toBe("exit_only");
    expect(parseAutonomy("full")).toBe("full");
  });

  it("reads ANYTHING else as off", () => {
    // The one place here that must fail closed. An unreadable grant is not a
    // grant — a bad migration or a fat-fingered update must not authorise
    // unattended trading on every leash at once.
    for (const v of [
      null,
      undefined,
      "",
      "off",
      "OFF",
      "Full",
      "exit-only",
      "true",
      "1",
      "yes",
      "full ",
    ]) {
      expect(parseAutonomy(v as string | null)).toBe("off");
    }
  });

  it("is case-sensitive on purpose — a near miss is not a grant", () => {
    expect(parseAutonomy("FULL")).toBe("off");
  });
});

describe("agentMay", () => {
  it("off permits nothing", () => {
    expect(agentMay("off", "open")).toBe(false);
    expect(agentMay("off", "close")).toBe(false);
  });

  it("exit_only may close and may NEVER open", () => {
    // The property that makes this mode safe to hand out: it cannot increase
    // exposure. The worst it can do is take a profit earlier than the hunter
    // would have.
    expect(agentMay("exit_only", "close")).toBe(true);
    expect(agentMay("exit_only", "open")).toBe(false);
  });

  it("full may do both", () => {
    expect(agentMay("full", "open")).toBe(true);
    expect(agentMay("full", "close")).toBe(true);
  });

  it("no mode permits opening without permitting closing", () => {
    // An agent that may open but not close is the ratchet this whole design
    // exists to avoid. Assert it structurally rather than trusting the table.
    for (const m of AUTONOMY_MODES) {
      if (agentMay(m, "open")) expect(agentMay(m, "close")).toBe(true);
    }
  });
});

describe("isAutonomyMode", () => {
  it("accepts exactly the three modes", () => {
    for (const m of AUTONOMY_MODES) expect(isAutonomyMode(m)).toBe(true);
  });

  it("rejects everything else", () => {
    for (const v of [null, 1, {}, "FULL", "exit-only", ""]) {
      expect(isAutonomyMode(v)).toBe(false);
    }
  });
});
