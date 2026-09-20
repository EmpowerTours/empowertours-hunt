import { prisma } from "@/lib/db/prisma";
import { readCookie, readSession, SESSION_COOKIE } from "./mera";
import {
  verifyClaimSignature,
  type SignedClaim,
  type VerifyOptions,
} from "./eip712";

// ---------------------------------------------------------------------------
// The auth boundary.
//
// Routes import from HERE and nowhere else. The provider must not leak into a
// route: the moment a route knows HOW a caller authenticated, swapping that out
// stops being a config change and becomes a refactor of every endpoint — and
// mera is explicitly in PREVIEW, so that swap has to stay cheap. The boundary
// stays even though there is now only one provider behind it; that is the
// point of a boundary.
//
// Everything in this file fails CLOSED. Every failure — a forged cookie, an
// expired one, unset env, a database error — becomes an
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

/**
 * The passkey session, and nothing else.
 *
 * A Privy fallback used to sit behind this, for phones that could not do
 * WebAuthn. It was removed 2026-09-19 because it could not do the job it was
 * there for: the wallet on this app IS the passkey — the PRF output for
 * (credential, rpId, salt) run through BIP-39 (lib/auth/derive.ts) — so a
 * player who came in through Privy would have been handed a DIFFERENT wallet
 * with a different balance, silently. A fallback that answers "you are signed
 * in" with the wrong address is worse than no fallback.
 *
 * It was also already inert: resolveWalletFromPrivyToken returned null without
 * NEXT_PUBLIC_PRIVY_APP_ID, and no such id was ever built into the deployed
 * client, so no player has ever authenticated this way in production.
 *
 * The real fallback for a phone whose credential manager refuses the app is
 * the one that ships: the native Credential Manager path
 * (lib/auth/native-passkey.ts) and, failing that, the prompt to open the site
 * in Chrome — both of which reach the SAME passkey and therefore the same
 * wallet.
 */
async function resolveWallet(req: Request): Promise<string> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) throw new AuthError("unauthenticated");

  const result = readSession(token);
  if (!result.ok) throw new AuthError(result.reason);
  return result.wallet;
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
