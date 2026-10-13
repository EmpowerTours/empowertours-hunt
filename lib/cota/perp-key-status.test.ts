import { describe, expect, it } from "vitest";
import { parsePerpKeyStatus, perpKeyCreatedLabel } from "./perp-key-status";

describe("perpKeyCreatedLabel", () => {
  it("includes the creation date when known", () => {
    expect(perpKeyCreatedLabel("2026-10-01T12:00:00Z", "en")).toBe(
      "Perpl key already created on Oct 1, 2026",
    );
    expect(perpKeyCreatedLabel(new Date("2026-10-01T12:00:00Z"), "es")).toMatch(
      /^Clave de Perpl ya creada el 1 .*2026$/,
    );
  });
  it("falls back gracefully when the date is missing or invalid", () => {
    expect(perpKeyCreatedLabel(null, "en")).toBe("Perpl key already created");
    expect(perpKeyCreatedLabel("nope", "en")).toBe("Perpl key already created");
    expect(perpKeyCreatedLabel(undefined, "es")).toBe("Clave de Perpl ya creada");
  });
});

describe("parsePerpKeyStatus", () => {
  it("reads a stored key with its date", () => {
    expect(parsePerpKeyStatus({ stored: true, createdAt: "2026-10-01T00:00:00.000Z" })).toEqual({
      stored: true,
      createdAt: "2026-10-01T00:00:00.000Z",
    });
  });
  it("tolerates old responses and junk", () => {
    expect(parsePerpKeyStatus({ stored: true })).toEqual({ stored: true, createdAt: null });
    expect(parsePerpKeyStatus({ stored: false, createdAt: "2026-10-01" })).toEqual({ stored: false, createdAt: null });
    expect(parsePerpKeyStatus(null)).toEqual({ stored: false, createdAt: null });
    expect(parsePerpKeyStatus({ stored: true, createdAt: "bad" })).toEqual({ stored: true, createdAt: null });
  });
});
