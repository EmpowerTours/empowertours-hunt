// Bot check on identity minting — Cloudflare Turnstile.
//
// WHAT THIS IS FOR, AND WHAT IT IS NOT FOR
//
// This guards REGISTRATION, not claiming. A captcha proves a human is present.
// It cannot prove the human is where they say they are, which is the whole of
// the spoofing problem, so putting one on the claim path would tax every real
// player standing outdoors on a phone and buy nothing: a spoofer solves it, or
// buys solutions in bulk for about a dollar per thousand, against a payout
// worth far more than that.
//
// On registration the arithmetic reverses. A genuine player solves one, once,
// ever. A farm minting identities solves one per identity. That is the whole
// argument for it being here and nowhere else.
//
// It is still not the sybil bound — the route header is right that the bound is
// economic and lives in the Hunt budget columns. This raises the unit cost of a
// fake identity; it does not cap the damage one can do.
//
// CONFIGURATION
//
// Enforced only when TURNSTILE_SECRET_KEY is set. Unset means every request
// passes, which is deliberate — this shipped onto a live product, and a captcha
// that rejects everyone the moment it deploys without keys is an outage, not a
// control. `captchaConfigured()` exists so a caller can log the difference
// rather than let it pass silently, which is the failure mode that let
// minAccountAgeSeconds sit at 0 and read as "gate on".
//
// When it IS configured it fails CLOSED. A verifier that waves requests through
// when Cloudflare is unreachable is a fuse an attacker can blow on purpose —
// the same reasoning `checkLimit` uses for its money paths.

const VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Cloudflare's cap on a Turnstile token. */
const MAX_TOKEN_BYTES = 2048;
const TIMEOUT_MS = 5000;

export type CaptchaResult =
  | { ok: true; enforced: boolean }
  | { ok: false; reason: string };

export function captchaConfigured(): boolean {
  return (process.env.TURNSTILE_SECRET_KEY ?? "").length > 0;
}

/**
 * Verify a Turnstile token.
 *
 * `remoteIp` is passed to Cloudflare when known; it sharpens their scoring and
 * is not used for any decision here.
 */
export async function verifyCaptcha(
  token: string | null | undefined,
  remoteIp: string | null,
): Promise<CaptchaResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY ?? "";
  if (secret.length === 0) return { ok: true, enforced: false };

  if (!token || token.length === 0) {
    return { ok: false, reason: "captcha_missing" };
  }
  if (token.length > MAX_TOKEN_BYTES) {
    return { ok: false, reason: "captcha_malformed" };
  }

  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);

  let res: Response;
  try {
    res = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Fail closed. See the header note.
    return { ok: false, reason: "captcha_unavailable" };
  }

  if (!res.ok) return { ok: false, reason: "captcha_unavailable" };

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return { ok: false, reason: "captcha_unavailable" };
  }

  const success =
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { success?: unknown }).success === true;

  return success ? { ok: true, enforced: true } : { ok: false, reason: "captcha_failed" };
}
