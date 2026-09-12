import { describe, expect, it } from "vitest";
import { denialTextEn, refusalText, type RefusalReason } from "./denial-text";
import { explainDenial, mayOpen, type DenyReason } from "./enforce";

// Every reason the gate and the trade route can emit. Listed by hand on
// purpose: a new DenyReason added to enforce.ts fails `denialTextEn` to
// typecheck, and a new route refusal has to be added here, which is the moment
// to write its Spanish.
const ALL: RefusalReason[] = [
  "revoked",
  "not_yet_valid",
  "expired",
  "wrong_venue",
  "market_not_authorised",
  "notional_exceeded",
  "leverage_exceeded",
  "trade_count_exceeded",
  "daily_loss_reached",
  "state_unavailable",
  "loss_unverifiable",
  "size_zero",
];

describe("refusal text", () => {
  it("has real text in both languages for every reason", () => {
    for (const reason of ALL) {
      for (const lang of ["es", "en"] as const) {
        const text = refusalText(reason, lang);
        expect(text, `${reason}/${lang}`).toBeTruthy();
        expect(text.length, `${reason}/${lang}`).toBeGreaterThan(10);
      }
    }
  });

  // An untranslated string is worse than an English one: it looks translated.
  it("never serves the English string as the Spanish one", () => {
    for (const reason of ALL) {
      expect(refusalText(reason, "es"), reason).not.toBe(
        refusalText(reason, "en"),
      );
    }
  });

  it("returns null for a code this build doesn't know", () => {
    expect(refusalText("reason_from_a_newer_server", "es")).toBeNull();
  });

  // One table, two callers. If explainDenial ever grows its own copy, a change
  // to one would silently leave the browser saying something else.
  it("gives the server and the browser the same English sentence", () => {
    for (const reason of ALL.slice(0, 9) as DenyReason[]) {
      expect(explainDenial(reason)).toBe(refusalText(reason, "en"));
      expect(denialTextEn(reason)).toBe(refusalText(reason, "en"));
    }
  });

  // The reason codes are not a hand-kept list of strings: they come out of the
  // gate itself. Prove at least one real denial round-trips to Spanish.
  it("covers a reason the gate actually produces", () => {
    const decision = mayOpen(
      {
        venue: "perpl",
        markets: ["MON"],
        maxNotionalUsdE6: 1_000_000n,
        maxLeverageX100: 300n,
        maxDailyLossUsdE6: 1_000_000n,
        maxTradesPerDay: 1,
        notBefore: 0n,
        notAfter: 4_000_000_000n,
        revokedAt: null,
      },
      { tradesToday: 0, lossTodayUsdE6: 0n, openNotionalUsdE6: 0n },
      {
        venue: "perpl",
        market: "MON",
        notionalUsdE6: 5_000_000n,
        leverageX100: 100n,
      },
      1_789_171_200n,
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toBe("notional_exceeded");
    // The code the gate produced is a key this table serves, in Spanish.
    const es = refusalText(decision.reason, "es");
    expect(es).toBe(
      "Esa orden llevaría tu posición total más allá del tamaño que fijaste.",
    );
    expect(es).not.toBe(explainDenial(decision.reason));
  });
});
