// ---------------------------------------------------------------------------
// Locales.
//
// Two, on purpose. This is a walking game for Mexican villages whose operator
// and players are Spanish-speaking, with English for visitors. Adding a third
// means adding messages/<locale>.json and one line here — nothing else.
// ---------------------------------------------------------------------------

export const LOCALES = ["es", "en"] as const;
export type Locale = (typeof LOCALES)[number];

/**
 * Spanish, not English.
 *
 * The default is what an unknown visitor sees: no country header, a geo lookup
 * that failed, a bot. For this product the local language is the better guess
 * every time, and an English speaker can switch in one tap.
 */
export const DEFAULT_LOCALE: Locale = "es";

/** Cookie holding the resolved locale. Not secret — it is a display preference. */
export const LOCALE_COOKIE = "hunt_locale";

/**
 * Set when the visitor chose the language themselves. A manual choice OUTRANKS
 * geo forever: someone who taps "English" while standing in Guanajuato has told
 * us something the IP address cannot.
 */
export const LOCALE_OVERRIDE_COOKIE = "hunt_locale_manual";

export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" && (LOCALES as readonly string[]).includes(value)
  );
}

/**
 * ISO-3166 country -> locale.
 *
 * An allowlist rather than "Spanish everywhere in Latin America", because the
 * exceptions are the point: Brazil is Portuguese, Belize is English, and
 * guessing from a continent would get both wrong.
 */
const COUNTRY_LOCALE: Record<string, Locale> = {
  MX: "es",
  ES: "es",
  AR: "es",
  CO: "es",
  CL: "es",
  PE: "es",
  VE: "es",
  EC: "es",
  GT: "es",
  CU: "es",
  BO: "es",
  DO: "es",
  HN: "es",
  PY: "es",
  SV: "es",
  NI: "es",
  CR: "es",
  PA: "es",
  UY: "es",
  GQ: "es",
  US: "en",
  GB: "en",
  CA: "en",
  AU: "en",
  NZ: "en",
  IE: "en",
  BZ: "en",
  ZA: "en",
};

/** The locale for a country code, or null when we have no opinion. */
export function localeForCountry(country: string | null): Locale | null {
  if (!country) return null;
  return COUNTRY_LOCALE[country.toUpperCase()] ?? null;
}
