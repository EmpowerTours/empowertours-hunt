// Persist a manual language choice.
//
// Geo decides the FIRST visit; this decides every one after it. A visitor who
// taps a language has told us something an IP address cannot — a Canadian in
// Guanajuato, a Spanish speaker on a US SIM — so the cookie written here
// outranks geo permanently in i18n/request.ts.
//
// POST, not GET: a GET that changes state can be fired by any page that
// prefetches or previews the URL.

import { NextResponse } from "next/server";
import { LOCALE_COOKIE, isLocale } from "@/lib/i18n/config";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  const locale = (body as { locale?: unknown })?.locale;

  // Allowlist, not sanitisation. The value goes into a Set-Cookie header and
  // is later used to build an import path in i18n/request.ts, so anything but
  // a known locale is refused outright rather than cleaned up.
  if (!isLocale(locale)) {
    return NextResponse.json({ error: "unsupported locale" }, { status: 400 });
  }

  const res = NextResponse.json({ locale });
  res.cookies.set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
    // Readable by script on purpose: it is a display preference, not a
    // credential, and the switcher reflects the current choice without a
    // round trip. Nothing is authorised by this value.
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
  });
  return res;
}
