// ---------------------------------------------------------------------------
// Which country is this request coming from?
//
// Geo-IP, by explicit choice. The usual signal is `Accept-Language`, and it is
// the more accurate one for LANGUAGE — a browser set to English says so even in
// Guanajuato. Geo answers a different question: where the body is standing.
// That was the call made for this product, so the resolution order below leans
// on country and keeps Accept-Language only as a fallback for when geo cannot
// answer at all.
//
// RAILWAY SENDS NO COUNTRY HEADER. Vercel (`x-vercel-ip-country`) and
// Cloudflare (`cf-ipcountry`) do, so those are read first and cost nothing:
// putting Cloudflare in front of this deployment later would silently upgrade
// it from a lookup to a header. Until then the client IP is resolved once per
// visitor and cached in a cookie, so the external call happens on a first visit
// and never again.
// ---------------------------------------------------------------------------

/** Country headers, cheapest first. Any edge that sets one saves a lookup. */
const COUNTRY_HEADERS = [
  "cf-ipcountry", // Cloudflare
  "x-vercel-ip-country", // Vercel
  "x-country-code", // some proxies
  "x-geo-country",
] as const;

const COUNTRY_RE = /^[A-Za-z]{2}$/;

/** A country the edge already told us, or null. */
export function countryFromHeaders(headers: Headers): string | null {
  for (const name of COUNTRY_HEADERS) {
    const value = headers.get(name)?.trim();
    // Cloudflare sends "XX" for anonymised addresses and "T1" for Tor. Neither
    // is a country, and both must not be mistaken for one.
    if (value && COUNTRY_RE.test(value) && value.toUpperCase() !== "XX") {
      return value.toUpperCase();
    }
  }
  return null;
}

/**
 * The client IP, from the leftmost `x-forwarded-for` entry.
 *
 * Client-controlled in general, and trustworthy here only because Railway's
 * proxy rewrites the header. It is used ONLY to pick a language — never as an
 * authorisation input. `lib/auth` has its own copy of this reasoning for the
 * rate limiter; do not start trusting it for anything else.
 */
export function clientIpFromHeaders(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return first;
  return headers.get("x-real-ip")?.trim() ?? null;
}

const PRIVATE_IP =
  /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd)/i;

/**
 * Resolve an IP to a country code.
 *
 * Two providers, both free and keyless, tried in order. A geo lookup is a
 * nice-to-have on a page load, so everything here fails to `null` rather than
 * throwing: the caller falls back to Accept-Language and then to the default,
 * and a visitor never sees an error because a language guess timed out.
 *
 * The timeout is deliberately short. This runs before the first byte of the
 * first response, so a slow third party must cost a fraction of a second and
 * then get out of the way.
 */
export async function countryFromIp(
  ip: string,
  timeoutMs = 1200,
): Promise<string | null> {
  if (!ip || PRIVATE_IP.test(ip)) return null;

  const endpoints = [
    {
      url: `https://api.country.is/${encodeURIComponent(ip)}`,
      read: (j: unknown) => (j as { country?: string })?.country,
    },
    {
      url: `https://ipwho.is/${encodeURIComponent(ip)}?fields=country_code`,
      read: (j: unknown) => (j as { country_code?: string })?.country_code,
    },
  ];

  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint.url, {
        signal: AbortSignal.timeout(timeoutMs),
        // The answer for an IP does not change often, and this is a language
        // guess, so a stale one is harmless and a cached one is free.
        next: { revalidate: 86_400 },
      });
      if (!res.ok) continue;
      const value = endpoint.read(await res.json());
      if (typeof value === "string" && COUNTRY_RE.test(value)) {
        return value.toUpperCase();
      }
    } catch {
      // Timeout, DNS failure, malformed JSON, provider outage. Try the next.
    }
  }
  return null;
}

/**
 * Last resort: the browser's own stated preference.
 *
 * Only consulted when geo produced nothing. Parsed rather than string-matched
 * so that `en-GB`, `es-419` and a q-weighted list all land correctly.
 */
export function localeFromAcceptLanguage(
  header: string | null,
  supported: readonly string[],
): string | null {
  if (!header) return null;

  const entries = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith("q="))
        ?.slice(2);
      const quality = q === undefined ? 1 : Number.parseFloat(q);
      return {
        tag: tag.trim().toLowerCase(),
        // A malformed q must not sort above a real one. NaN sorts to the back.
        quality: Number.isFinite(quality) ? quality : 0,
      };
    })
    .filter((e) => e.tag.length > 0)
    .sort((a, b) => b.quality - a.quality);

  for (const entry of entries) {
    const base = entry.tag.split("-")[0];
    if (supported.includes(base)) return base;
  }
  return null;
}
