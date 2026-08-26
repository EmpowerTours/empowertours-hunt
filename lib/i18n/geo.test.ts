import { describe, it, expect } from "vitest";
import {
  countryFromHeaders,
  clientIpFromHeaders,
  localeFromAcceptLanguage,
} from "./geo";

const h = (o: Record<string, string>) => new Headers(o);

describe("countryFromHeaders", () => {
  it("reads Cloudflare and Vercel country headers", () => {
    expect(countryFromHeaders(h({ "cf-ipcountry": "mx" }))).toBe("MX");
    expect(countryFromHeaders(h({ "x-vercel-ip-country": "US" }))).toBe("US");
  });

  it("ignores Cloudflare's XX for anonymised addresses", () => {
    // XX is "unknown", not a country. Treating it as one would map to nothing
    // anyway, but it must not stop the IP lookup from running.
    expect(countryFromHeaders(h({ "cf-ipcountry": "XX" }))).toBeNull();
  });

  it("ignores anything that is not two letters", () => {
    expect(countryFromHeaders(h({ "cf-ipcountry": "T1" }))).toBeNull();
    expect(countryFromHeaders(h({ "cf-ipcountry": "MEX" }))).toBeNull();
    expect(countryFromHeaders(h({ "cf-ipcountry": "" }))).toBeNull();
    expect(countryFromHeaders(h({}))).toBeNull();
  });
});

describe("clientIpFromHeaders", () => {
  it("takes the leftmost forwarded entry", () => {
    expect(
      clientIpFromHeaders(h({ "x-forwarded-for": "189.203.0.1, 10.0.0.1" })),
    ).toBe("189.203.0.1");
  });

  it("falls back to x-real-ip, then null", () => {
    expect(clientIpFromHeaders(h({ "x-real-ip": "8.8.8.8" }))).toBe("8.8.8.8");
    expect(clientIpFromHeaders(h({}))).toBeNull();
  });
});

describe("localeFromAcceptLanguage", () => {
  const supported = ["es", "en"];

  it("matches a bare tag and a regional one", () => {
    expect(localeFromAcceptLanguage("es", supported)).toBe("es");
    expect(localeFromAcceptLanguage("en-GB", supported)).toBe("en");
    expect(localeFromAcceptLanguage("es-419", supported)).toBe("es");
  });

  it("respects q-weighting rather than list order", () => {
    expect(
      localeFromAcceptLanguage("en;q=0.2, es;q=0.9", supported),
    ).toBe("es");
    expect(
      localeFromAcceptLanguage("fr, en;q=0.8, es;q=0.3", supported),
    ).toBe("en");
  });

  it("sorts a malformed q to the back instead of trusting it", () => {
    // NaN must not compare as the highest priority.
    expect(
      localeFromAcceptLanguage("en;q=banana, es;q=0.5", supported),
    ).toBe("es");
  });

  it("returns null when nothing is supported", () => {
    expect(localeFromAcceptLanguage("fr, de, ja", supported)).toBeNull();
    expect(localeFromAcceptLanguage(null, supported)).toBeNull();
    expect(localeFromAcceptLanguage("", supported)).toBeNull();
  });
});
