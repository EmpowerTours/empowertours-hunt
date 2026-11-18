import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Chip Board session tokens, minted here and verified by the Go game server
// (services/chipboard/internal/auth/auth.go). The two must agree byte for
// byte; both are tested against services/chipboard/internal/auth/testdata/
// token_vectors.json.
//
//   playerId.expiry.signature
//
// expiry is Unix seconds in decimal; signature is base64url (no padding) of
// HMAC-SHA256(secret, playerId + "." + expiry). Server-only: never import this
// from a client component.
// ---------------------------------------------------------------------------

/** Same as auth.MinSecretLen on the Go side. */
export const MIN_SECRET_LEN = 32;

/** How long a minted token is good for. It is only read once, at connect. */
export const TOKEN_TTL_S = 120;

/** 1-64 of A-Z a-z 0-9 _ : - (no dot: it separates the token's parts). */
const PLAYER_ID = /^[A-Za-z0-9_:-]{1,64}$/;

export function validPlayerId(id: string): boolean {
  return PLAYER_ID.test(id);
}

/** The configured secret, or null when it is missing or too short (fail closed). */
export const TEST_SECRET_PREFIX = "TEST-ONLY";

export function sessionSecret(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const s = env.CHIPBOARD_SESSION_SECRET;
  // Secrets starting TEST-ONLY are committed test fixtures, public by
  // definition: refuse them like a missing secret (the Go server does too).
  if (!s || s.startsWith(TEST_SECRET_PREFIX)) return null;
  return s.length >= MIN_SECRET_LEN ? s : null;
}

export function mintToken(
  playerId: string,
  expiryUnixS: number,
  secret: string,
): string {
  if (!validPlayerId(playerId)) throw new Error("invalid player id");
  if (!Number.isSafeInteger(expiryUnixS) || expiryUnixS <= 0)
    throw new Error("invalid expiry");
  if (secret.length < MIN_SECRET_LEN) throw new Error("secret too short");
  const payload = `${playerId}.${expiryUnixS}`;
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
