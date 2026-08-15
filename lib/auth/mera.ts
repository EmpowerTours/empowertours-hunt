import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isAddress } from "viem";
import {
  verifySessionSignature,
  type SignedSession,
  type VerifyOptions,
  type VerifyResult,
} from "./eip712";

// ---------------------------------------------------------------------------
// Mera adapter — the PRIMARY player auth provider.
//
// --- What mera actually is (verified, see the report) ----------------------
//
// mera (`@category-labs/mera`, Category Labs) is a BROWSER library. Its whole
// surface is client-side WebAuthn and key derivation:
//
//   createPasskeyWithPrfOutput, getPasskeyPrfOutput, WebAuthnClient
//   createSecp256k1SigningSession, createEd25519SigningSession, toViemAccount
//   getEvmAddress, getSolanaAddress
//   createSecretVaultWithNewPasskey, createSecretVaultWithExistingPasskey,
//   decryptSecretVaultWithPasskey, parseSecretVault
//
// A passkey's PRF output (32 deterministic secret bytes) is derived into a
// secp256k1 key in the browser; getEvmAddress turns its public key into an
// EIP-55 address. There is NO server SDK and NO server-side verification API —
// the documentation has no server component at all.
//
// That is not a gap, it is the design, and it decides the shape of this file:
// a mera account is an ordinary secp256k1 keypair, so the server authenticates
// it exactly the way it authenticates any wallet — by verifying a signature
// over a challenge it can bound. No mera dependency is needed on the server,
// which also means a breaking change in mera's PREVIEW API cannot take server
// logins down; at worst the browser half needs updating.
//
// --- The flow --------------------------------------------------------------
//
//   1. browser: getPasskeyPrfOutput -> derive key -> createSecp256k1SigningSession
//   2. browser: toViemAccount(session).signTypedData(Session payload)
//   3. server:  POST /api/auth/session verifies it here and mints the cookie
//   4. server:  requirePlayer reads the cookie
//
// The cookie this file mints is HttpOnly, unlike Privy's, so an XSS cannot read
// it. Belt and braces: it is only a session, and every money action still needs
// a fresh EIP-712 signature the cookie cannot produce.
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = "hunt_session";

/** Seven days. The cookie authorises reads; money needs a fresh signature. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const TOKEN_VERSION = "v1";
const MIN_SECRET_LENGTH = 32;

export type SessionResult =
  | { ok: true; wallet: string; credentialId: string | null }
  | { ok: false; reason: string };

function sessionSecret(): Buffer | null {
  const secret = process.env.AUTH_SESSION_SECRET;
  // Refuse a short secret rather than accept a weak one. A missing secret means
  // no session can be minted OR verified, which fails closed in both directions.
  if (!secret || secret.length < MIN_SECRET_LENGTH) return null;
  return Buffer.from(secret, "utf8");
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(body: string, secret: Buffer): string {
  return b64url(createHmac("sha256", secret).update(body).digest());
}

interface SessionPayload {
  /** Lowercased wallet address. */
  w: string;
  /** Mera passkey credential id, when the player signed in with a passkey. */
  c?: string;
  /** Issued at, unix seconds. */
  iat: number;
  /** Expires at, unix seconds. */
  exp: number;
}

/**
 * Mint an opaque HMAC-SHA256 session token.
 *
 * Deliberately not a JWT: there is no third party to interoperate with, and a
 * JWT would introduce an algorithm field — the header an attacker edits first.
 * This format has exactly one algorithm and one key, and the version prefix is
 * inside the signed bytes so it cannot be downgraded either.
 */
export function issueSession(
  walletAddress: string,
  credentialId?: string | null,
  nowMs: number = Date.now(),
): string {
  const secret = sessionSecret();
  if (!secret) throw new Error("AUTH_SESSION_SECRET is not configured");
  if (!isAddress(walletAddress, { strict: false })) {
    throw new Error("issueSession requires a wallet address");
  }

  const iat = Math.floor(nowMs / 1000);
  const payload: SessionPayload = {
    w: walletAddress.toLowerCase(),
    iat,
    exp: iat + SESSION_TTL_SECONDS,
  };
  if (credentialId) payload.c = credentialId.slice(0, 256);

  const body = `${TOKEN_VERSION}.${b64url(Buffer.from(JSON.stringify(payload), "utf8"))}`;
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verify and decode a session token. Any doubt returns a failure — a malformed
 * token, a bad MAC, an expired one, or a missing secret.
 */
export function readSession(token: string): SessionResult {
  const secret = sessionSecret();
  if (!secret) return { ok: false, reason: "invalid session" };
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) {
    return { ok: false, reason: "invalid session" };
  }

  const lastDot = token.lastIndexOf(".");
  if (lastDot <= 0) return { ok: false, reason: "invalid session" };
  const body = token.slice(0, lastDot);
  const mac = token.slice(lastDot + 1);
  if (!body.startsWith(`${TOKEN_VERSION}.`)) {
    return { ok: false, reason: "invalid session" };
  }

  const expected = Buffer.from(sign(body, secret), "utf8");
  const given = Buffer.from(mac, "utf8");
  // Length check first: timingSafeEqual throws on a length mismatch, and the
  // length of an HMAC is not a secret.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "invalid session" };
  }

  let payload: SessionPayload;
  try {
    const json = Buffer.from(body.slice(TOKEN_VERSION.length + 1), "base64url");
    payload = JSON.parse(json.toString("utf8")) as SessionPayload;
  } catch {
    return { ok: false, reason: "invalid session" };
  }

  // Reject-by-default: every field must positively check out. Written so a
  // missing or NaN exp fails the comparison instead of sliding through it.
  if (
    typeof payload?.w !== "string" ||
    !isAddress(payload.w, { strict: false })
  ) {
    return { ok: false, reason: "invalid session" };
  }
  if (!(typeof payload.exp === "number" && Number.isFinite(payload.exp))) {
    return { ok: false, reason: "invalid session" };
  }
  if (!(payload.exp * 1000 > Date.now())) {
    return { ok: false, reason: "session expired" };
  }

  return {
    ok: true,
    wallet: payload.w.toLowerCase(),
    credentialId: typeof payload.c === "string" ? payload.c : null,
  };
}

/**
 * Verify a mera (or any secp256k1 wallet) login signature.
 *
 * Returns the recovered lowercased address. Same nonce and clock-skew bounds as
 * a claim, so a captured login signature is single-use and short-lived.
 */
export function verifyMeraLogin(
  payload: SignedSession,
  opts?: VerifyOptions,
): Promise<VerifyResult> {
  return verifySessionSignature(payload, opts);
}

/** A fresh challenge nonce, in the format lib/auth/eip712.ts accepts. */
export function newNonce(): string {
  return randomBytes(24).toString("base64url");
}

// --- Cookie helpers --------------------------------------------------------

/**
 * Read one cookie from a Request.
 *
 * Parsed off the raw header rather than via next/headers so this stays a pure
 * function of the Request — testable, and usable from any runtime.
 */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

function secureAttribute(): string {
  // Secure is omitted only on a local http:// dev server, where it would stop
  // the cookie being set at all.
  return process.env.NODE_ENV === "production" ? "; Secure" : "";
}

/**
 * Set-Cookie value for a new session.
 *
 * HttpOnly: this is the property Privy's cookie does not have, and the reason
 * an XSS there yields a replayable bearer token.
 * SameSite=Lax: a cross-site POST does not carry it. The EIP-712 signature is
 * the real CSRF control; this is the cheap layer in front of it.
 */
export function sessionCookieHeader(token: string): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ]
    .join("; ")
    .concat(secureAttribute());
}

/** Set-Cookie value that clears the session. */
export function clearSessionCookieHeader(): string {
  return [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ]
    .join("; ")
    .concat(secureAttribute());
}
