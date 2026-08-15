import { prisma } from "@/lib/db/prisma";
import { readCookie, readSession, SESSION_COOKIE } from "./mera";
import { resolveWalletFromPrivyToken } from "./privy";
import {
  verifyClaimSignature,
  type SignedClaim,
  type VerifyOptions,
} from "./eip712";

// ---------------------------------------------------------------------------
// The auth boundary.
//
// Routes import from HERE and nowhere else. Neither Mera nor Privy may leak
// into a route: the moment a route knows which provider authenticated a caller,
// swapping providers stops being a config change and becomes a refactor of
// every endpoint — and mera is explicitly in PREVIEW, so that swap has to stay
// cheap.
//
// Everything in this file fails CLOSED. Every failure — a forged cookie, an
// expired one, a Privy outage, unset env, a database error — becomes an
// AuthError, which a route renders as 401. There is no branch that returns an
// anonymous-but-allowed caller, which is why requirePlayer throws rather than
// returning null: a nullable return invites `if (player) { ... }` with no else.
//
// It also does NOT auto-create a Player. Registration is open but explicit
// (app/api/register). An auto-create inside a claim would let a wallet enrol
// itself mid-hunt, which is the sybil path the budget ceilings exist to bound.
// ---------------------------------------------------------------------------

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export interface SessionPlayer {
  id: string;
  walletAddress: string;
  active: boolean;
  suspendedAt: Date | null;
}

export type AuthProvider = "mera" | "privy";

/**
 * Which providers may authenticate, in order.
 *
 * AUTH_PROVIDERS is a comma-separated list; the default tries the mera session
 * cookie first and falls back to Privy. This is the knob that matters: if
 * mera's preview API breaks the browser half, set AUTH_PROVIDERS=privy and
 * logins keep working without a deploy of any route.
 */
export function enabledProviders(): AuthProvider[] {
  const raw = process.env.AUTH_PROVIDERS;
  if (!raw) return ["mera", "privy"];

  const parsed = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is AuthProvider => s === "mera" || s === "privy");

  // An unparseable value must not silently disable auth, and must not silently
  // enable a provider the operator meant to turn off. Fall back to the default.
  return parsed.length > 0 ? parsed : ["mera", "privy"];
}

async function resolveWallet(req: Request): Promise<string> {
  const providers = enabledProviders();
  let lastReason = "unauthenticated";

  for (const provider of providers) {
    if (provider === "mera") {
      const token = readCookie(req, SESSION_COOKIE);
      if (!token) continue;
      const result = readSession(token);
      if (result.ok) return result.wallet;
      lastReason = result.reason;
      continue;
    }

    // Privy's own cookie name. Also accepted as a bearer header, which is how
    // a native client that cannot hold cookies authenticates.
    const header = req.headers.get("authorization");
    const bearer =
      header && header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    const token = readCookie(req, "privy-token") ?? bearer;
    if (!token) continue;

    const result = await resolveWalletFromPrivyToken(token);
    if (result.ok) return result.wallet;
    lastReason = result.reason;
  }

  throw new AuthError(lastReason);
}

/**
 * Resolve the calling player, or throw.
 *
 * The address is lowercased before lookup because Player.walletAddress is
 * stored lowercased; a checksummed comparison would silently never match and
 * lock a registered player out of a hunt they are standing in.
 */
export async function requirePlayer(req: Request): Promise<SessionPlayer> {
  const walletAddress = (await resolveWallet(req)).toLowerCase();

  let player: SessionPlayer | null;
  try {
    player = await prisma.player.findUnique({
      where: { walletAddress },
      select: {
        id: true,
        walletAddress: true,
        active: true,
        suspendedAt: true,
      },
    });
  } catch {
    // A database error is not an authentication. Fails closed.
    throw new AuthError("invalid session");
  }

  if (!player) throw new AuthError("not registered for the hunt");
  return player;
}

/**
 * Verify an EIP-712 signed claim. Returns the recovered, lowercased address.
 *
 * Throws AuthError on every failure. The reason string stays deliberately
 * coarse in what a route echoes back: whether a claim failed on the nonce or on
 * the signature tells an attacker which half to work on next.
 */
export async function verifySignedClaim(
  payload: SignedClaim,
  opts?: VerifyOptions,
): Promise<string> {
  const result = await verifyClaimSignature(payload, opts);
  if (!result.ok) throw new AuthError(result.reason);
  return result.address;
}

/**
 * Client IP for rate limiting.
 *
 * Reads the leftmost x-forwarded-for entry. That value is client-controlled in
 * general — it is only trustworthy because the platform proxy (Railway/Vercel)
 * rewrites the header, and it is used ONLY as a rate-limit key, never as an
 * authorisation input. Do not start trusting it for anything else.
 */
export function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() ?? "unknown";
}

export {
  HUNT_DOMAIN,
  CLAIM_ATTEMPT_TYPES,
  REGISTRATION_TYPES,
  SESSION_TYPES,
  SESSION_STATEMENT,
  CLOCK_SKEW_SECONDS,
  NONCE_TTL_SECONDS,
  type SignedClaim,
  type SignedRegistration,
  type SignedSession,
} from "./eip712";
export { SESSION_COOKIE, SESSION_TTL_SECONDS } from "./mera";
