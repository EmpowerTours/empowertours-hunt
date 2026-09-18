import { describe, expect, it } from "vitest";
import { decide, type AgentInputs } from "./decide";
import type { PositionSnapshot } from "../exit";

const ENTRY = 0.022531778;
const pos = (signedSize: number, exitPriceUsd: number): PositionSnapshot => ({
  signedSize,
  entryUsd: ENTRY,
  exitPriceUsd,
  feesPaidUsd: 0.011553,
});

const base: AgentInputs = {
  mode: "full",
  position: null,
  exitPriceUsd: null,
  mayOpenNow: true,
};

describe("permission comes first", () => {
  it("off does nothing, holding or flat", () => {
    expect(decide({ ...base, mode: "off" }).act).toBe("nothing");
    expect(
      decide({
        ...base,
        mode: "off",
        position: pos(576, ENTRY * 1.05),
        exitPriceUsd: ENTRY * 1.05,
      }).act,
    ).toBe("nothing");
  });

  it("exit_only never opens, even flat with the leash allowing it", () => {
    const d = decide({ ...base, mode: "exit_only" });
    expect(d.act).toBe("nothing");
    expect(d.why).toBe("grant_forbids_open");
  });

  it("exit_only DOES close a profitable position", () => {
    const d = decide({
      ...base,
      mode: "exit_only",
      position: pos(576, ENTRY * 1.013),
      exitPriceUsd: ENTRY * 1.013,
    });
    expect(d.act).toBe("close");
  });
});

describe("closing is considered before opening", () => {
  it("never returns open while holding anything", () => {
    // An agent that opens while a position it should have closed is still on
    // the book compounds a mistake it had already detected.
    for (const px of [ENTRY * 0.9, ENTRY, ENTRY * 1.1]) {
      const d = decide({
        ...base,
        position: pos(576, px),
        exitPriceUsd: px,
        mayOpenNow: true,
      });
      expect(d.act).not.toBe("open");
    }
  });
});

describe("opening only from flat", () => {
  it("opens when flat, permitted and the leash allows", () => {
    expect(decide(base).act).toBe("open");
  });

  it("does not open when the leash refuses", () => {
    const d = decide({ ...base, mayOpenNow: false });
    expect(d.act).toBe("nothing");
    expect(d.why).toBe("leash_refuses_open");
  });

  it("never ADDS to a losing position, though the leash would allow it", () => {
    // The ratchet guard. With no stop-loss, an agent that may add has no state
    // from which it must eventually act — it buys more, holds, buys more.
    const d = decide({
      ...base,
      position: pos(576, ENTRY * 0.9),
      exitPriceUsd: ENTRY * 0.9,
      mayOpenNow: true,
    });
    expect(d.act).toBe("nothing");
    expect(d.why).toBe("holding");
  });
});

describe("refusing rather than guessing", () => {
  it("does nothing when the book gave no exit price", () => {
    // Falling back to the mark is what makes a losing close look profitable.
    const d = decide({
      ...base,
      position: pos(576, ENTRY),
      exitPriceUsd: null,
    });
    expect(d.act).toBe("nothing");
    expect(d.why).toBe("no_exit_price");
  });

  it("holds a position that is up but not up enough", () => {
    const d = decide({
      ...base,
      position: pos(576, ENTRY * 1.005),
      exitPriceUsd: ENTRY * 1.005,
    });
    expect(d.act).toBe("nothing");
    expect(d.why).toBe("holding");
  });
});

describe("the invariant that matters", () => {
  it("never closes at a loss, across the whole price range", () => {
    for (let bps = -2000; bps <= 2000; bps += 10) {
      const px = ENTRY * (1 + bps / 10_000);
      const d = decide({ ...base, position: pos(576, px), exitPriceUsd: px });
      if (d.act === "close") expect(d.netUsd).toBeGreaterThan(0);
    }
  });

  it("only ever returns one action", () => {
    const acts = new Set<string>();
    for (const mode of ["off", "exit_only", "full"] as const) {
      for (const holding of [true, false]) {
        for (const px of [ENTRY * 0.95, ENTRY * 1.02]) {
          acts.add(
            decide({
              ...base,
              mode,
              position: holding ? pos(576, px) : null,
              exitPriceUsd: holding ? px : null,
            }).act,
          );
        }
      }
    }
    expect([...acts].sort()).toEqual(["close", "nothing", "open"]);
  });
});

describe("observe decides as full would, so the log is worth reading", () => {
  it("still reports a take-profit it is not allowed to take", () => {
    // The whole point: a hunter in observe must see "it would have closed here",
    // with the number, or they have nothing to judge before letting it act.
    const d = decide({
      ...base,
      mode: "observe",
      position: pos(576, ENTRY * 1.013),
      exitPriceUsd: ENTRY * 1.013,
    });
    expect(d.act).toBe("close");
    if (d.act === "close") expect(d.netUsd).toBeGreaterThan(0);
  });

  it("still reports an open it is not allowed to take", () => {
    // exit_only would report grant_forbids_open here and tell the hunter
    // nothing about the agent's judgement. observe shows the judgement.
    expect(decide({ ...base, mode: "observe" }).act).toBe("open");
  });

  it("and exit_only still refuses to evaluate an open", () => {
    // Confirms observe is not simply "full" — the other modes are unchanged.
    const d = decide({ ...base, mode: "exit_only" });
    expect(d.act).toBe("nothing");
    expect(d.why).toBe("grant_forbids_open");
  });
});
