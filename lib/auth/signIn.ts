"use client";

import type { ClaimMessage, ClaimSigner } from "@/components/hunt/types";
import {
  createAccount,
  explainPasskeyError,
  signInAccount,
  storedCredential,
  type PasskeyAccount,
} from "./passkey";
import {
  claimAttemptTypedData,
  registrationTypedData,
  sessionTypedData,
} from "./messages";
import { SESSION_STATEMENT } from "./typedData";

// ---------------------------------------------------------------------------
// Passkey -> signature -> session. This is the browser half the server has been
// waiting for: /api/auth/session and /api/register both recover the address FROM
// the signature, so nothing here can assert an identity it does not hold a key
// for.
// ---------------------------------------------------------------------------

/** Matches the server's /^[A-Za-z0-9_-]{16,128}$/. 16 bytes -> 22 base64url chars. */
function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * A nonce and a timestamp for one signature.
 *
 * Prefers the server's clock. `clientTs` is rejected when it sits further than
 * CLOCK_SKEW_SECONDS (120) from the server's own time, and a phone's clock
 * drifting past two minutes is ordinary — which would present to a player
 * outdoors as "invalid signature", with nothing they could do about it. Taking
 * `serverTs` removes that failure mode without weakening the check: the point
 * of the window is to bound how long a captured signature stays usable, and a
 * signature stamped at server time is exactly what it is meant to see.
 *
 * Falls back to generating locally, which /api/auth/nonce's own documentation
 * says is equally valid — single use is enforced at consumption, not issue.
 */
async function freshNonce(): Promise<{ nonce: string; ts: number }> {
  try {
    const res = await fetch("/api/auth/nonce", { cache: "no-store" });
    if (res.ok) {
      const body: unknown = await res.json();
      if (typeof body === "object" && body !== null) {
        const { nonce, serverTs } = body as {
          nonce?: unknown;
          serverTs?: unknown;
        };
        if (typeof nonce === "string" && typeof serverTs === "number") {
          return { nonce, ts: serverTs };
        }
      }
    }
  } catch {
    // Offline or the route is down. A locally generated nonce still verifies.
  }
  return { nonce: newNonce(), ts: nowSeconds() };
}

async function errorFrom(res: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof (body as { error: unknown }).error === "string"
    ) {
      return (body as { error: string }).error;
    }
  } catch {
    // Non-JSON body; the status is all we have.
  }
  return fallback;
}

/**
 * Sign in, registering first if this wallet has never played.
 *
 * Registration is deliberately a separate server route, but a player should not
 * have to know that: they tap once. The 404 from /api/auth/session is the
 * server saying "valid signature, unknown wallet", which is exactly the moment
 * to register.
 */
async function establishSession(passkey: PasskeyAccount): Promise<void> {
  const wallet = passkey.account.address;

  const { nonce: loginNonce, ts: loginTs } = await freshNonce();
  const loginSignature = await passkey.account.signTypedData(
    sessionTypedData({ wallet, clientTs: loginTs, nonce: loginNonce }),
  );

  const login = await fetch("/api/auth/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      wallet,
      statement: SESSION_STATEMENT,
      clientTs: loginTs,
      nonce: loginNonce,
      signature: loginSignature,
      passkeyCredentialId: passkey.credentialId,
    }),
  });

  if (login.ok) return;
  if (login.status !== 404) {
    throw new Error(await errorFrom(login, "Could not sign in."));
  }

  // Never played before. A fresh nonce and timestamp: the login nonce has just
  // been burned, and the two messages are verified independently.
  const { nonce: regNonce, ts: regTs } = await freshNonce();
  // Sent as "" rather than omitted — REGISTRATION_TYPES includes it, so the
  // signed message and the request body have to agree byte for byte. A player
  // can attach a TURBO handle later; making it a precondition of walking
  // outside would be worse.
  const turboUsername = "";
  const regSignature = await passkey.account.signTypedData(
    registrationTypedData({
      wallet,
      turboUsername,
      passkeyCredentialId: passkey.credentialId,
      clientTs: regTs,
      nonce: regNonce,
    }),
  );

  const registered = await fetch("/api/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      wallet,
      turboUsername,
      passkeyCredentialId: passkey.credentialId,
      clientTs: regTs,
      nonce: regNonce,
      signature: regSignature,
    }),
  });

  if (!registered.ok) {
    throw new Error(await errorFrom(registered, "Could not register."));
  }
}

/**
 * How many times in a row the assertion has come back empty-handed.
 *
 * WebAuthn cannot tell us whether the player cancelled or simply has no passkey
 * — NotAllowedError covers both, on purpose, so a site cannot probe which
 * credentials someone holds. That ambiguity matters here: creating a passkey
 * when one already exists hands the player a DIFFERENT wallet and orphans their
 * credit. So a failed assertion never creates; it takes two consecutive
 * failures before the third tap makes a new wallet, and each step says what the
 * next one will do.
 */
const FAILURES_BEFORE_CREATE = 2;
const FAILURE_KEY = "hunt.passkey.assertFailures";

/**
 * Kept in sessionStorage rather than a module variable so it survives a reload:
 * a player whose first tap fails often reloads before trying again, and a
 * counter that reset there would never reach the create branch. It also means
 * no shared mutable module state is written after an await.
 */
function readFailures(): number {
  try {
    const n = Number(sessionStorage.getItem(FAILURE_KEY) ?? "0");
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeFailures(n: number): void {
  try {
    sessionStorage.setItem(FAILURE_KEY, String(n));
  } catch {
    // Private browsing. Falls back to "always try to find an existing wallet",
    // which is the safe direction: it never silently creates a second one.
  }
}

/**
 * Only one sign-in runs at a time.
 *
 * Two concurrent calls would open two WebAuthn ceremonies — a double-tap on the
 * button is enough — and on a device with no passkey the second could reach the
 * create branch while the first was still deciding, handing the player two
 * wallets. Returning the in-flight promise makes a second tap join the first.
 */
let inFlight: Promise<void> | null = null;

/** Registered with `<Providers signIn>`. One tap: find the wallet, or make one. */
export function signInWithPasskey(): Promise<void> {
  if (inFlight !== null) return inFlight;
  inFlight = runSignIn().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runSignIn(): Promise<void> {
  // Snapshot before any await; the write below is computed from the snapshot.
  const failuresSoFar = readFailures();
  let passkey: PasskeyAccount | null = null;
  try {
    if (failuresSoFar >= FAILURES_BEFORE_CREATE) {
      passkey = await createAccount();
    } else {
      try {
        passkey = await signInAccount();
      } catch (err) {
        // A known local credential means this really is their device and the
        // ceremony failed for some other reason. Never offer to create there.
        if (storedCredential() !== undefined) {
          throw new Error(explainPasskeyError(err));
        }
        const failures = failuresSoFar + 1;
        writeFailures(failures);
        throw new Error(
          failures >= FAILURES_BEFORE_CREATE
            ? "No hunt wallet found. Tap sign in once more and a new one will be created for you."
            : "Couldn't open your hunt wallet. If you cancelled, tap sign in again to retry.",
        );
      }
    }
    await establishSession(passkey);
    writeFailures(0);
  } finally {
    // Zero the key as soon as we are done with it, on every path.
    passkey?.session.end();
  }
}

/**
 * Registered with `<Providers signer>`. Signs one claim or spawn collect.
 *
 * Face ID runs per signature by design: this is the path that moves real MON,
 * and AGENTS.md requires every attempt to be individually signed and
 * non-repudiable. Holding a key open across a walk to save a prompt would trade
 * exactly the property the signature exists to provide.
 */
export const claimSigner: ClaimSigner = async (message: ClaimMessage) => {
  let passkey: PasskeyAccount | null = null;
  try {
    passkey = await signInAccount();
    return await passkey.account.signTypedData(
      claimAttemptTypedData({
        huntId: message.huntId,
        lat: message.lat,
        lng: message.lng,
        accuracyM: message.accuracyM,
        clientTs: message.clientTs,
        nonce: message.nonce,
      }),
    );
  } finally {
    passkey?.session.end();
  }
};
