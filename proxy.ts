import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Origin/Referer allowlist on mutating API requests.
//
// Next 16's built-in cross-origin protection covers SERVER ACTIONS. It does not
// cover Route Handlers, and every money path in this app is a Route Handler, so
// without this file there is no origin check on them at all.
//
// This is defence in depth, not the CSRF control. The real control is the
// EIP-712 signature on every claim and collect: an attacker who can make the
// browser send a request still cannot produce a signature. This layer exists
// because it is nearly free, and because it also blocks the requests that carry
// no signature — logout, registration, admin mutations.
//
// NOTE ON THE FILE NAME: Next 16 renamed this convention from `middleware` to
// `proxy`. Both are still detected, but `middleware` logs a deprecation warning
// and Next hard-errors if BOTH files exist — verified in
// next/dist/build/index.js. The migration is a pure rename of the file and the
// exported function; nothing else changes. This file is edge-safe anyway — no
// node builtins, no Prisma, no crypto.
// ---------------------------------------------------------------------------

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Paths exempt from the origin check.
 *
 * /api/cron/* is called server-to-server by a scheduler that sends no Origin
 * header. It is not unprotected: it carries CRON_SECRET as a bearer, which is
 * a stronger control than an origin check and one a browser cannot replay.
 *
 * /api/cota/check is the same shape and exempt for the same reason: a trading
 * agent asks it whether an order is inside a bound the user signed, from a
 * server, with no browser anywhere in the path. It carries COTA_AGENT_TOKEN as
 * a bearer and REFUSES EVERYTHING without it — an unset token, a wrong token
 * and an unknown digest all answer `allow: false`. Exempting a route that
 * failed open would be trading one control for none; this one fails closed,
 * which is why the trade is sound.
 */
const EXEMPT_PREFIXES = ["/api/cron/", "/api/cota/check"];

function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Is this origin the app's own parent domain or a subdomain of it?
 *
 * The app is served on several hosts under one registrable domain (hunt, cota,
 * turbo … under empowertours.xyz = NEXT_PUBLIC_RP_ID). Railway's proxy rewrites
 * Host, so `req.nextUrl.host` is NOT a reliable same-origin anchor — which is
 * why a same-origin POST from cota was refused. Matching the ORIGIN header
 * (browser-set, unspoofable by a hostile page) against the known parent domain
 * is host-independent and still safe: a cross-site attacker's origin is never
 * under empowertours.xyz.
 */
function isOwnDomain(candidate: string): boolean {
  const parent = process.env.NEXT_PUBLIC_RP_ID?.trim().toLowerCase();
  if (!parent || !parent.includes(".") || parent === "localhost") return false;
  try {
    const host = new URL(candidate).host.toLowerCase();
    return host === parent || host.endsWith(`.${parent}`);
  } catch {
    return false;
  }
}

/**
 * Allowed origins.
 *
 * When ALLOWED_ORIGINS is set it is authoritative — that is the deployment that
 * knows its own public hostname, including one behind a proxy that rewrites
 * Host. When it is not set we fall back to same-origin, comparing against the
 * request's own host. That fallback trusts the Host header, which is why the
 * env var is the recommended configuration and not merely an override.
 */
function allowedOrigins(req: NextRequest): Set<string> {
  const allowed = new Set<string>();

  // Extra trusted origins for genuinely cross-origin callers. ADDITIVE — it no
  // longer short-circuits and replaces the same-origin allowance below. Setting
  // it to hunt's host used to make every same-origin POST from a SIBLING
  // subdomain (cota, turbo) 403 with "cross-origin request refused", even
  // though those requests are same-origin. That was the cota sign-in failure.
  const configured = process.env.ALLOWED_ORIGINS;
  if (configured) {
    for (const entry of configured.split(",")) {
      const normalized = originOf(entry.trim());
      if (normalized) allowed.add(normalized);
    }
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (appUrl) {
    const normalized = originOf(appUrl);
    if (normalized) allowed.add(normalized);
  }

  // ALWAYS allow same-origin. A request whose Origin equals the host it is
  // addressed to is not cross-site by definition, so it is never the CSRF
  // threat this guard exists to stop — a hostile page's Origin is its own, and
  // will not match. This is what lets the same app serve on several subdomains
  // (hunt, cota) without enumerating each. The real control on money paths
  // stays the EIP-712 signature; this layer is depth, and same-origin costs it
  // nothing.
  allowed.add(`${req.nextUrl.protocol}//${req.nextUrl.host}`.toLowerCase());
  return allowed;
}

export function proxy(req: NextRequest) {
  if (!MUTATING.has(req.method)) return NextResponse.next();

  const path = req.nextUrl.pathname;
  if (EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return NextResponse.next();
  }

  const allowed = allowedOrigins(req);

  // Origin is sent by every browser on a cross-origin request and on every
  // same-origin POST. Referer is the fallback for the handful of clients that
  // suppress Origin.
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  const candidate = origin
    ? originOf(origin)
    : referer
      ? originOf(referer)
      : null;

  // Reject by default: an absent or unparseable Origin AND Referer is refused,
  // not waved through. Written as `if (!(good))` so a null candidate cannot
  // slip past a comparison. A browser always sends one of them on a mutating
  // request, so this costs a real client nothing; it costs a scripted or
  // cross-site caller the request.
  if (
    candidate === null ||
    !(allowed.has(candidate) || isOwnDomain(candidate))
  ) {
    return NextResponse.json(
      { error: "cross-origin request refused" },
      { status: 403 },
    );
  }

  return NextResponse.next();
}

export const config = {
  // Only the API surface. Page navigations are not state-changing here, and
  // running this on every asset request would be pure cost.
  matcher: ["/api/:path*"],
};
