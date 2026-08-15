// Admin session and login-nonce cookies.
//
// Deliberately NOT Mera and NOT Privy. Player auth is preview software and is
// scoped to players; the operator console releases real MON, so its front door
// is a plain EIP-4361 (SIWE) wallet signature checked against `AdminUser`.
//
// Two signed cookies, both HttpOnly, both HMAC-SHA256 over an env secret:
//
//   admin_nonce    short-lived, single-use. Signed because the client can set
//                  any cookie value it likes — an UNSIGNED nonce cookie would
//                  let an attacker who captured a login signature simply set
//                  the cookie to the captured nonce and replay it. Signing
//                  means only a nonce this server issued is ever accepted, and
//                  it is cleared the moment it is consumed.
//   admin_session  carries only the AdminUser id + expiry. The role is NEVER
//                  carried in the cookie: it is re-read from the database on
//                  every single request, so a demotion or a deactivation takes
//                  effect immediately instead of at the next login.
//
// The secret comes from env with no fallback. A missing secret throws, which
// makes every admin route fail closed rather than silently accept a signature
// verified against a hardcoded default.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SESSION_COOKIE = "hunt_admin_session";
const NONCE_COOKIE = "hunt_admin_nonce";

// Short enough that an unattended console stops being a standing risk, long
// enough that an operator working a queue is not re-signing every few minutes.
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const NONCE_TTL_MS = 5 * 60 * 1000;

export const ADMIN_SESSION_COOKIE = SESSION_COOKIE;
export const ADMIN_NONCE_COOKIE = NONCE_COOKIE;
export const ADMIN_SESSION_TTL_MS = SESSION_TTL_MS;
export const ADMIN_NONCE_TTL_MS = NONCE_TTL_MS;

function secret(): Buffer {
  const raw = process.env.ADMIN_SESSION_SECRET;
  if (!raw || raw.length < 32) {
    // No default. An admin console whose cookie signing key is a build-time
    // constant is an admin console anyone can forge a session for.
    throw new Error(
      "ADMIN_SESSION_SECRET is not set (needs >= 32 chars). Admin auth is disabled.",
    );
  }
  return Buffer.from(raw, "utf8");
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Constant-time compare that cannot throw on a length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * `<payload-base64url>.<hmac>` where payload is JSON. Both cookies use the
 * same envelope so there is only one verification path to get right.
 */
function seal(value: object): string {
  const payload = Buffer.from(JSON.stringify(value), "utf8").toString(
    "base64url",
  );
  return `${payload}.${sign(payload)}`;
}

function unseal<T>(token: string | undefined): T | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);

  let expected: string;
  try {
    expected = sign(payload);
  } catch {
    // Missing secret. Fail closed rather than propagating a 500 out of a
    // read-only "am I logged in?" check.
    return null;
  }
  if (!safeEqual(mac, expected)) return null;

  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

interface NoncePayload {
  n: string;
  exp: number;
}

interface SessionPayload {
  sub: string;
  exp: number;
}

export interface CookieSpec {
  name: string;
  value: string;
  options: {
    httpOnly: true;
    secure: boolean;
    sameSite: "strict";
    path: string;
    maxAge: number;
  };
}

function cookieOptions(maxAgeSeconds: number): CookieSpec["options"] {
  return {
    httpOnly: true,
    // `secure` off in dev only so localhost works over http. Anything that is
    // not explicitly development gets the secure flag.
    secure: process.env.NODE_ENV === "production",
    // Strict, not Lax: no cross-site navigation should ever arrive carrying an
    // operator session that can release money.
    sameSite: "strict",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/** Mint a fresh login nonce plus the signed cookie that vouches for it. */
export function issueNonce(): { nonce: string; cookie: CookieSpec } {
  const nonce = randomBytes(16).toString("hex");
  const exp = Date.now() + NONCE_TTL_MS;
  return {
    nonce,
    cookie: {
      name: NONCE_COOKIE,
      value: seal({ n: nonce, exp } satisfies NoncePayload),
      options: cookieOptions(Math.floor(NONCE_TTL_MS / 1000)),
    },
  };
}

/**
 * The nonce this server issued to this browser, or null. Callers must clear
 * the cookie after a successful login so the nonce is genuinely single-use.
 */
export function readNonce(token: string | undefined): string | null {
  const payload = unseal<NoncePayload>(token);
  if (!payload) return null;
  if (typeof payload.n !== "string" || typeof payload.exp !== "number")
    return null;
  if (!(payload.exp > Date.now())) return null;
  return payload.n;
}

export function issueSession(adminId: string): CookieSpec {
  const exp = Date.now() + SESSION_TTL_MS;
  return {
    name: SESSION_COOKIE,
    value: seal({ sub: adminId, exp } satisfies SessionPayload),
    options: cookieOptions(Math.floor(SESSION_TTL_MS / 1000)),
  };
}

/** AdminUser id carried by a valid, unexpired session cookie, or null. */
export function readSession(token: string | undefined): string | null {
  const payload = unseal<SessionPayload>(token);
  if (!payload) return null;
  if (typeof payload.sub !== "string" || typeof payload.exp !== "number")
    return null;
  if (!(payload.exp > Date.now())) return null;
  return payload.sub;
}

export function clearedCookie(name: string): CookieSpec {
  return { name, value: "", options: cookieOptions(0) };
}
