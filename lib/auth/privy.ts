import { PrivyClient } from "@privy-io/server-auth";

// ---------------------------------------------------------------------------
// Privy adapter — the FALLBACK player auth provider.
//
// Kept because a player who already registered for the TURBO curriculum has a
// Privy identity, and because Mera is in preview: if its API moves, logins fall
// back here instead of going down.
//
// What is deliberately NOT done here: hand-rolled JWT verification. Privy's
// verifyAuthToken already pins ES256, checks the issuer, and binds appId as the
// audience. Re-implementing that is how an `alg: none` or an unbound-audience
// bug gets introduced. Do not replace it with jose/jwt-decode.
//
// --- M2, the defect this file fixes ---------------------------------------
//
// The previous lib/auth.ts constructed a NEW PrivyClient on every call, and
// called the constructor twice per request (once for verifyAuthToken, once for
// getUser). PrivyClient memoises the ES256 verification key PER INSTANCE, so a
// fresh instance means the key is not cached: every authenticated request
// fetched it from auth.privy.io BEFORE the JWT signature was checked. An
// unauthenticated attacker posting a garbage cookie therefore forced an
// outbound API call per request — a free amplifier pointed at our own auth
// provider, and a hard dependency on Privy's availability for rejecting junk.
//
// Fixed by:
//   * one module-scoped client, so the verification key is fetched once per
//     process and a garbage token is then rejected LOCALLY with no network I/O;
//   * a short-TTL userId -> wallet cache, so the second round trip (getUser)
//     is amortised instead of paid on every request.
//
// Note the wallet CANNOT be read from the token claims: AuthTokenClaims is
// { appId, issuer, issuedAt, expiration, sessionId, userId } — verified against
// @privy-io/server-auth@1.32.5 dist/dts/public-DTbbnwMV.d.ts. There is no
// wallet field, so getUser cannot be eliminated outright, only cached.
// ---------------------------------------------------------------------------

export type PrivyResult =
  { ok: true; wallet: string } | { ok: false; reason: string };

let client: PrivyClient | null = null;
let clientAppId: string | null = null;

function getClient(): PrivyClient | null {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  // Missing env is a failure, never an allow. The caller turns this into a 401.
  if (!appId || !appSecret) return null;

  if (client && clientAppId === appId) return client;
  client = new PrivyClient(appId, appSecret);
  clientAppId = appId;
  return client;
}

/**
 * Warm the verification key so the first real request does not pay for it, and
 * so a cold instance rejects a garbage token without an outbound call. Safe to
 * call and ignore; a failure here must not surface as an auth success.
 */
export async function prewarmPrivy(): Promise<void> {
  const c = getClient();
  if (!c) return;
  try {
    await c.getVerificationKey();
  } catch {
    // Non-fatal: verifyAuthToken will retry the fetch on the next request.
  }
}

// --- userId -> wallet cache ------------------------------------------------

interface CachedWallet {
  wallet: string;
  expiresAt: number;
}

const WALLET_TTL_MS = 5 * 60_000;
const MAX_CACHED_WALLETS = 10_000;
const walletCache = new Map<string, CachedWallet>();

function cacheGet(userId: string): string | null {
  const hit = walletCache.get(userId);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    walletCache.delete(userId);
    return null;
  }
  return hit.wallet;
}

function cacheSet(userId: string, wallet: string): void {
  // Bounded: userId comes from a token we have already verified, so this is not
  // attacker-chosen, but an unbounded process-lifetime map is a leak regardless.
  if (walletCache.size >= MAX_CACHED_WALLETS) {
    const now = Date.now();
    for (const [k, v] of walletCache) {
      if (v.expiresAt <= now) walletCache.delete(k);
    }
    while (walletCache.size >= MAX_CACHED_WALLETS) {
      const oldest = walletCache.keys().next();
      if (oldest.done) break;
      walletCache.delete(oldest.value);
    }
  }
  walletCache.set(userId, { wallet, expiresAt: Date.now() + WALLET_TTL_MS });
}

/**
 * Resolve the lowercased wallet address behind a Privy session token.
 *
 * Returns a failure result for every non-success — an expired token, a forged
 * one, a Privy outage, an account with no wallet, or missing env. The caller
 * maps all of them to 401. Nothing in here may return ok on a doubt.
 */
export async function resolveWalletFromPrivyToken(
  token: string,
): Promise<PrivyResult> {
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) {
    return { ok: false, reason: "invalid session" };
  }

  const c = getClient();
  if (!c) return { ok: false, reason: "invalid session" };

  let userId: string;
  try {
    // With the singleton this is a local ES256 check once the key is cached.
    const claims = await c.verifyAuthToken(token);
    userId = claims.userId;
  } catch {
    return { ok: false, reason: "invalid session" };
  }
  if (!userId) return { ok: false, reason: "invalid session" };

  const cached = cacheGet(userId);
  if (cached) return { ok: true, wallet: cached };

  try {
    const user = await c.getUser(userId);
    const wallet = user.wallet?.address;
    if (!wallet) return { ok: false, reason: "no wallet on this account" };
    const lower = wallet.toLowerCase();
    cacheSet(userId, lower);
    return { ok: true, wallet: lower };
  } catch {
    // Privy outage. Fails CLOSED: a caller we cannot resolve is not a caller we
    // trust, even briefly.
    return { ok: false, reason: "invalid session" };
  }
}

/** Test seam. Never called from application code. */
export function __resetPrivyState(): void {
  client = null;
  clientAppId = null;
  walletCache.clear();
}
