import { describe, expect, it } from "vitest";
import { readback, readbackOf, readbackSummary } from "./readback";
import { leverageX100, usdE6 } from "./scale";
import type { CotaMessage } from "./typedData";

const NOT_AFTER = BigInt(Math.floor(Date.UTC(2026, 9, 13, 0, 0, 0) / 1000));

function message(over: Partial<CotaMessage> = {}): CotaMessage {
  return {
    venue: "perpl",
    markets: ["BTC"],
    maxNotionalUsdE6: usdE6(200),
    maxLeverageX100: leverageX100(3),
    maxDailyLossUsdE6: usdE6(50),
    maxTradesPerDay: 10,
    notBefore: 0n,
    notAfter: NOT_AFTER,
    clientTs: 0n,
    nonce: "n".repeat(20),
    ...over,
  };
}

function byId(m: CotaMessage, id: string) {
  const line = readbackOf(m).find((l) => l.id === id);
  if (!line) throw new Error(`no line ${id}`);
  return line;
}

describe("every number the player reads is the number that was signed", () => {
  it("renders the ceilings from the scaled integers", () => {
    const m = message();
    expect(byId(m, "notional").en).toContain("$200");
    expect(byId(m, "leverage").en).toContain("3x");
    expect(byId(m, "loss").en).toContain("$50");
    expect(byId(m, "trades").en).toContain("10 trades");
  });

  it("shows cents when the signed value has them", () => {
    const m = message({ maxDailyLossUsdE6: usdE6(12.34) });
    expect(byId(m, "loss").en).toContain("$12.34");
    expect(byId(m, "loss").es).toContain("$12.34");
  });

  it("shows fractional leverage exactly as signed", () => {
    const m = message({ maxLeverageX100: leverageX100(2.5) });
    expect(byId(m, "leverage").en).toContain("2.5x");
  });
});

describe("an empty market list reads as a revocation", () => {
  it("says it authorises nothing, and says nothing else", () => {
    // The dangerous rendering would be an empty market name inside a sentence
    // that still describes permissions — a bound that authorises nothing must
    // not look like a bound that authorises everything.
    const lines = readbackOf(message({ markets: [] }));
    expect(lines).toHaveLength(1);
    expect(lines[0].id).toBe("nothing");
    expect(lines[0].en.toLowerCase()).toContain("no market");
    expect(lines[0].es.toLowerCase()).toContain("ningún mercado");
  });

  it("summarises as authorising nothing in both languages", () => {
    const m = message({ markets: [] });
    expect(readbackSummary(m, "en")).toBe("Authorises nothing.");
    expect(readbackSummary(m, "es")).toBe("No autoriza nada.");
  });
});

describe("both languages are always present", () => {
  it("gives every line a non-empty es and en", () => {
    // A missing translation would silently show an English sentence to a
    // player in Guerrero who is agreeing to a financial limit.
    for (const line of readbackOf(message())) {
      expect(line.es.length).toBeGreaterThan(0);
      expect(line.en.length).toBeGreaterThan(0);
      expect(line.es).not.toBe(line.en);
    }
  });

  it("keeps ids unique so the UI can key on them", () => {
    const ids = readbackOf(message()).map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the limits are marked as protective", () => {
  it("marks every ceiling, and not the permission", () => {
    const lines = readbackOf(message());
    const protective = lines.filter((l) => l.protective).map((l) => l.id);
    expect(protective).toContain("notional");
    expect(protective).toContain("leverage");
    expect(protective).toContain("loss");
    expect(protective).toContain("trades");
    expect(protective).toContain("expiry");
    // The venue clause grants; it does not protect. Marking it protective
    // would let the UI lead with a permission dressed as a safeguard.
    expect(protective).not.toContain("venue");
  });
});

describe("the loss clause says the part people get wrong", () => {
  it("states that unclosed losses count", () => {
    // Players assume a limit only bites once a trade is closed. It does not,
    // and the sentence has to say so or the read-back is misleading.
    const m = message();
    expect(byId(m, "loss").en).toContain("whether or not");
    expect(byId(m, "loss").es).toContain("cuente o no");
  });
});

describe("dates", () => {
  it("renders the expiry in UTC in both languages", () => {
    const m = message();
    expect(byId(m, "expiry").en).toContain("13 October 2026");
    expect(byId(m, "expiry").es).toContain("13 octubre 2026");
  });

  it("does not drift across a timezone boundary", () => {
    // 00:30 UTC on the 13th is still the 12th in Mexico City. The ceilings
    // reset on the UTC day, so the UTC date is the honest one to print.
    const m = message({
      notAfter: BigInt(Math.floor(Date.UTC(2026, 9, 13, 0, 30, 0) / 1000)),
    });
    expect(byId(m, "expiry").en).toContain("13 October 2026");
  });
});

describe("the summary leads with the loss ceiling", () => {
  it("puts the daily loss first in both languages", () => {
    const m = message();
    expect(readbackSummary(m, "en")).toMatch(/^Max \$50 loss a day/);
    expect(readbackSummary(m, "es")).toMatch(/^Máx\. \$50 de pérdida al día/);
  });

  it("singularises one trade", () => {
    const m = message({ maxTradesPerDay: 1 });
    expect(byId(m, "trades").en).toContain("1 trade a day");
    expect(byId(m, "trades").es).toContain("1 operación");
  });
});

describe("before a signature exists, the expiry is a duration", () => {
  // The window starts when the player signs, not when the page loaded. A date
  // computed at page load would print a promise slightly different from the
  // one actually signed — and would put a clock read inside render, where it
  // makes the message change on every re-render.
  it("says how long after signing, not a date", () => {
    const lines = readback(message(), { kind: "afterSigning", days: 30 });
    const expiry = lines.find((l) => l.id === "expiry");
    expect(expiry?.en).toBe(
      "Expires 30 days after you sign it. After that it authorises nothing.",
    );
    expect(expiry?.es).toContain("30 días después de firmarla");
  });

  it("singularises one day", () => {
    const lines = readback(message(), { kind: "afterSigning", days: 1 });
    const expiry = lines.find((l) => l.id === "expiry");
    expect(expiry?.en).toContain("1 day after");
    expect(expiry?.es).toContain("1 día después");
  });

  it("keeps the same id and protective flag either way", () => {
    // The UI sorts and keys on these, so the two expiry forms must be
    // interchangeable everywhere except the sentence itself.
    const rel = readback(message(), { kind: "afterSigning", days: 30 }).find(
      (l) => l.id === "expiry",
    );
    const abs = readbackOf(message()).find((l) => l.id === "expiry");
    expect(rel?.protective).toBe(true);
    expect(abs?.protective).toBe(true);
    expect(rel?.en).not.toBe(abs?.en);
  });
});
