import { describe, it, expect } from "vitest";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import { LOCALES, DEFAULT_LOCALE, localeForCountry, isLocale } from "./config";
import { SPAWN_DENY_REASONS } from "@/lib/hunt/spawn";

/* ---------------------------------------------------------------------------
   Catalogue parity.

   A missing key does not crash next-intl loudly — it renders the key path, so
   a Spanish player sees `spawnReason.out_of_range` where a sentence should be.
   That is the kind of defect nobody notices until someone is standing in a
   street holding a phone, which is exactly why it belongs in CI instead.
--------------------------------------------------------------------------- */

type Tree = { [k: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

const flatEn = flatten(en as Tree);
const flatEs = flatten(es as Tree);

describe("message catalogues", () => {
  it("have exactly the same keys", () => {
    expect([...flatEs.keys()].sort()).toEqual([...flatEn.keys()].sort());
  });

  it("have no empty strings", () => {
    for (const [locale, flat] of [
      ["en", flatEn],
      ["es", flatEs],
    ] as const) {
      for (const [key, value] of flat) {
        expect(`${locale}:${key}:${value.trim().length > 0}`).toBe(
          `${locale}:${key}:true`,
        );
      }
    }
  });

  it("use the same ICU placeholders in both languages", () => {
    // `{amount}` translated to `{cantidad}` renders the literal braces to the
    // player and silently drops the value.
    const placeholders = (s: string) =>
      [...s.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort();

    for (const [key, value] of flatEn) {
      expect(`${key}:${placeholders(flatEs.get(key)!)}`).toBe(
        `${key}:${placeholders(value)}`,
      );
    }
  });

  it("are not just the English copied across", () => {
    // A guard against a catalogue that was duplicated and never translated.
    // Proper nouns and short labels legitimately match, so this asserts that
    // the LONG strings differ, where a real translation always would.
    const long = [...flatEn].filter(([, v]) => v.length > 40);
    expect(long.length).toBeGreaterThan(8);
    const identical = long.filter(([k, v]) => flatEs.get(k) === v);
    expect(identical.map(([k]) => k)).toEqual([]);
  });
});

describe("locale config", () => {
  it("has a default that is one of the supported locales", () => {
    expect(isLocale(DEFAULT_LOCALE)).toBe(true);
    expect(LOCALES).toContain(DEFAULT_LOCALE);
  });

  it("maps the countries this product actually operates in", () => {
    expect(localeForCountry("MX")).toBe("es");
    expect(localeForCountry("mx")).toBe("es");
    expect(localeForCountry("US")).toBe("en");
  });

  it("has no opinion about a country it does not know", () => {
    // Reject-by-default: an unmapped country falls through to the next signal
    // rather than being guessed at from a continent.
    expect(localeForCountry("BR")).toBeNull();
    expect(localeForCountry("JP")).toBeNull();
    expect(localeForCountry(null)).toBeNull();
    expect(localeForCountry("")).toBeNull();
  });

  it("rejects a malformed locale rather than trusting a cookie", () => {
    expect(isLocale("fr")).toBe(false);
    expect(isLocale("")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale("es; rm -rf")).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
   Every refusal the player can hit must be sayable.

   Six spawn reasons — including `no_verified_position` — shipped with no
   message at all. The app knew exactly why nothing was happening and could not
   tell anyone: the player walked, saw a blank radar, and concluded it was
   broken. next-intl renders the key path rather than throwing, so nothing in
   CI noticed.

   This is the check that would have caught it. A rule nobody can run is not a
   control.
--------------------------------------------------------------------------- */

describe("spawn refusals", () => {
  it("every deny reason has a message in both languages", () => {
    for (const reason of SPAWN_DENY_REASONS) {
      expect(flatEn.has(`spawnReason.${reason}`), `en: ${reason}`).toBe(true);
      expect(flatEs.has(`spawnReason.${reason}`), `es: ${reason}`).toBe(true);
    }
  });
});
