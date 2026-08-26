import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";
import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_COOKIE,
  isLocale,
  localeForCountry,
  type Locale,
} from "@/lib/i18n/config";
import {
  clientIpFromHeaders,
  countryFromHeaders,
  countryFromIp,
  localeFromAcceptLanguage,
} from "@/lib/i18n/geo";

// ---------------------------------------------------------------------------
// Which language this request gets.
//
// Resolution order, most specific first:
//
//   1. The visitor's own choice, stored in a cookie. A tap always wins.
//   2. A country header from the edge, if one exists (Cloudflare/Vercel).
//   3. A geo-IP lookup of the client address.
//   4. Accept-Language.
//   5. Spanish.
//
// Steps 2 and 3 are the requested behaviour: language follows where the body
// is, not what the browser was configured with. Step 4 stays because geo can
// fail — a VPN, a private address, both providers down — and "no answer" must
// not mean "no language".
//
// No `[locale]` route segment. next-intl supports a routing-free setup as long
// as `locale` is returned explicitly here, which keeps every existing URL
// unchanged: hunt.empowertours.xyz/hunt/abc stays that, not /es/hunt/abc. For a
// link pasted into a village WhatsApp group that matters more than SEO does.
//
// The geo lookup is a `fetch`, so Next's data cache dedupes it: the first
// visitor from an address pays for it and everyone behind that address after
// them does not.
// ---------------------------------------------------------------------------

async function resolveLocale(): Promise<Locale> {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);

  // 1. An explicit choice outranks everything, forever.
  const chosen = cookieStore.get(LOCALE_COOKIE)?.value;
  if (isLocale(chosen)) return chosen;

  // 2. Free, when an edge in front of us provides it.
  const headerCountry = countryFromHeaders(headerList);
  const fromHeader = localeForCountry(headerCountry);
  if (fromHeader) return fromHeader;

  // 3. The lookup. Bounded and failure-tolerant; see lib/i18n/geo.ts.
  const ip = clientIpFromHeaders(headerList);
  if (ip) {
    const country = await countryFromIp(ip);
    const fromIp = localeForCountry(country);
    if (fromIp) return fromIp;
  }

  // 4. What the browser says, when geography could not say anything.
  const fromBrowser = localeFromAcceptLanguage(
    headerList.get("accept-language"),
    LOCALES,
  );
  if (isLocale(fromBrowser)) return fromBrowser;

  // 5. The local language, because this is a game played in Mexican streets.
  return DEFAULT_LOCALE;
}

export default getRequestConfig(async () => {
  const locale = await resolveLocale();
  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
    // Pinned so a server rendering in UTC and a phone in CDMX format the same
    // countdown. Spawn expiry is shown to the second; an hour of drift there
    // would read as a bug in the game rather than a bug in the timezone.
    timeZone: "America/Mexico_City",
  };
});
