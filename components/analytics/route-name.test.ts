import { describe, expect, it } from "vitest";
import { looksLikeId, routeName } from "./route-name";

describe("keeping identifiers out of analytics", () => {
  it("redacts the ids this app actually puts in paths", () => {
    // A real cuid from the production database.
    expect(routeName("/hunt/cmtlo4koj0000n81yt6zjt91d")).toBe("/hunt/:id");
    expect(routeName("/hunt/0xe2ab465839e409c80d1ca4bb4508fea7eb808395")).toBe(
      "/hunt/:id",
    );
    expect(routeName("/editions/42")).toBe("/editions/:id");
  });

  it("throws away query strings, which is where the tokens are", () => {
    // Single-use links and submit tokens ride in the query. Sending one to a
    // vendor would both leak it and log it somewhere we do not control.
    expect(routeName("/cota/trade?token=s3cr3t")).toBe("/cota/trade");
    expect(routeName("/dime?slots=1&k=abc123def456")).toBe("/dime");
    expect(routeName("/cota/history#results")).toBe("/cota/history");
  });

  it("leaves real route names alone, including nested ones", () => {
    expect(routeName("/cota/trade")).toBe("/cota/trade");
    expect(routeName("/cota/swap/usdc")).toBe("/cota/swap/usdc");
    expect(routeName("/cota/history")).toBe("/cota/history");
    expect(routeName("/judge/record")).toBe("/judge/record");
    expect(routeName("/")).toBe("/");
  });

  it("accepts a whole URL and still returns only the shape", () => {
    expect(
      routeName("https://cota.empowertours.xyz/hunt/cmtlo4koj0000n81yt6z?x=1"),
    ).toBe("/hunt/:id");
  });

  it("does not split one route in two over a trailing slash", () => {
    expect(routeName("/cota/trade/")).toBe("/cota/trade");
  });

  it("errs toward redacting an unknown segment", () => {
    // Over-redacting costs a coarser funnel. Under-redacting costs somebody's
    // identifier sitting in a vendor's database.
    expect(looksLikeId("aVeryLongUnknownSegment")).toBe(true);
    expect(looksLikeId("trade")).toBe(false);
    expect(looksLikeId("")).toBe(false);
  });
});
