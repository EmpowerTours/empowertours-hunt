import { describe, expect, it } from "vitest";
import { pickSavedAddress, swapHrefFor } from "./aurora-saved";

const usdc = { destinationAsset: "USDC", recipient: "0xa", id: 1 };
const mon = { destinationAsset: "MON", recipient: "0xa", id: 2 };
const other = { destinationAsset: "AUSD", recipient: "0xa", id: 3 };

describe("pickSavedAddress", () => {
  it("prefers the requested asset", () => {
    expect(pickSavedAddress([usdc, mon], "MON")).toBe(mon);
  });
  it("falls back to an older USDC address instead of nothing", () => {
    expect(pickSavedAddress([usdc], "MON")).toBe(usdc);
    expect(pickSavedAddress([other, usdc], "MON")).toBe(usdc);
  });
  it("falls back to any address", () => {
    expect(pickSavedAddress([other], "MON")).toBe(other);
  });
  it("returns null when nothing is saved", () => {
    expect(pickSavedAddress([], "MON")).toBeNull();
  });
  it("ignores rows paying a different wallet when a recipient is given", () => {
    expect(pickSavedAddress([usdc], "MON", "0xb")).toBeNull();
    expect(pickSavedAddress([usdc], "MON", "0xa")).toBe(usdc);
  });
});

describe("swapHrefFor", () => {
  it("routes USDC to the USDC swap", () => {
    expect(swapHrefFor("USDC")).toBe("/cota/swap/usdc");
    expect(swapHrefFor("MON")).toBe("/cota/swap");
    expect(swapHrefFor(undefined)).toBe("/cota/swap");
  });
});
