"use client";

import { createWalletClient, http } from "viem";
import { monad, monadRpcUrl } from "@/lib/monad";
import type { ClaimMessage, ClaimSigner } from "@/components/hunt/types";
import {
  accountFromPrfOutput,
  createAccount,
  explainPasskeyError,
  RP_ID,
  signInAccount,
  storedCredential,
  type PasskeyAccount,
} from "./passkey";
import { HUNT_PRF_SALT } from "./derive";
import { getPrfViaNative, nativePasskeyAvailable } from "./native-passkey";
import {
  claimAttemptTypedData,
  registrationTypedData,
  sessionTypedData,
} from "./messages";
import { SESSION_STATEMENT } from "./typedData";
import { getCaptchaToken } from "@/lib/auth/turnstile";

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

  // Only on the registration path. A returning player logs in above and never
  // sees this, so the cost falls on identity creation, which is the thing being
  // rationed. Null when no site key is configured.
  const captchaToken = await getCaptchaToken();

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
      ...(captchaToken === null ? {} : { captchaToken }),
    }),
  });

  if (!registered.ok) {
    throw new Error(await errorFrom(registered, "Could not register."));
  }
}

/**
 * Thrown when the assertion came back empty-handed on a device that knows no
 * credential of ours — i.e. making a wallet here is a reasonable next move.
 *
 * WebAuthn cannot tell us whether the player cancelled or simply has no passkey
 * — NotAllowedError covers both, on purpose, so a site cannot probe which
 * credentials someone holds. That ambiguity is why creating is never automatic:
 * creating a passkey when one already exists hands the player a DIFFERENT
 * wallet and orphans their credit.
 *
 * It used to be resolved by counting failures — two empty assertions and the
 * third tap silently created. That read, to a first-time player, as the app
 * being broken twice: Android shows its own "No passkeys available for
 * empowertours.xyz on this device" sheet, and the only way forward was to tap
 * the same button again on faith. Reported as "hunt isn't working", which is a
 * fair description of what it looked like.
 *
 * So the branch is a question the player answers instead of a counter they
 * cannot see: this error carries the offer, and `createWalletWithPasskey` is a
 * second, differently-labelled button. Same safety property — nothing creates
 * without a deliberate act — one fewer dead end.
 */
export class NoPasskeyFoundError extends Error {
  /** Lets the UI show the create button without matching on message text. */
  readonly canCreateWallet = true;

  /**
   * What the ceremony ACTUALLY said, kept for the screen to show.
   *
   * "No wallet on this phone" is the right sentence for a player and a useless
   * one for anybody diagnosing, because three different failures produce it:
   * a WebView that cannot do WebAuthn at all (NotSupportedError), an
   * asset-links delegation the device would not honour (SecurityError), and a
   * genuine empty lookup or a cancelled prompt (NotAllowedError). Throwing the
   * friendly sentence and dropping the cause meant a phone could only ever
   * report the symptom, and the person holding it is not the person who can
   * read logcat.
   */
  readonly detail?: string;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = "NoPasskeyFoundError";
    this.detail = detail;
  }
}

/**
 * Only one ceremony runs at a time, across BOTH entry points.
 *
 * Two concurrent calls would open two WebAuthn ceremonies — a double-tap is
 * enough — and sign-in racing create could hand the player two wallets. One
 * shared slot means a second tap joins the first rather than starting another.
 */
let inFlight: Promise<void> | null = null;

function exclusive(work: () => Promise<void>): Promise<void> {
  if (inFlight !== null) return inFlight;
  inFlight = work().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Registered with `<Providers signIn>`. Opens the wallet this phone can reach. */
export function signInWithPasskey(): Promise<void> {
  return exclusive(runSignIn);
}

/**
 * Registered with `<Providers createWallet>`. Makes a NEW passkey and wallet.
 *
 * Only ever reached from a button the player pressed after being told what it
 * does. It still refuses on a device that already knows one of our credentials:
 * a UI change must not be able to turn this into the path that orphans someone's
 * balance, so the invariant is checked here rather than trusted to the caller.
 */
export function createWalletWithPasskey(): Promise<void> {
  return exclusive(runCreateWallet);
}

async function runSignIn(): Promise<void> {
  let passkey: PasskeyAccount | null = null;
  try {
    try {
      passkey = await signInAccount();
    } catch (err) {
      // SECOND ROAD, inside the app only.
      //
      // The WebView does WebAuthn through Play services' FIDO2 APIs, and on
      // some devices that path fails while Credential Manager — what Chrome
      // uses on the same phone, with the same passkey — works. Measured on a
      // vivo running OriginOS 6: NotReadableError in three seconds from the
      // WebView, a clean sign-in from Chrome.
      //
      // Tried only AFTER the ordinary path has failed, so nothing changes for
      // the phones that already work. Same salt, same derivation, so a wallet
      // reached this way is the SAME wallet — that is the whole requirement,
      // and it is why this calls accountFromPrfOutput rather than deriving
      // anything of its own.
      const native = await nativePasskeyAvailable().catch(() => false);
      if (native) {
        try {
          const known = storedCredential();
          const { prfOutput, credentialId } = await getPrfViaNative({
            rpId: RP_ID,
            prfSalt: HUNT_PRF_SALT,
            credentialId: known?.credentialId,
          });
          passkey = accountFromPrfOutput(prfOutput, credentialId);
          await establishSession(passkey);
          return;
        } catch (nativeErr) {
          // Report the NATIVE failure, not the WebView one. If both roads are
          // shut, the second error is the more informative — the first is
          // already known to fail on this class of device.
          if (storedCredential() !== undefined) {
            throw new Error(explainPasskeyError(nativeErr));
          }
          throw new NoPasskeyFoundError(
            "No hunt wallet on this phone. If you have played before, open the hunt on the phone you first signed in with — or make a new wallet below.",
            explainPasskeyError(nativeErr),
          );
        }
      }

      // A known local credential means this really is their device and the
      // ceremony failed for some other reason. Never offer to create there.
      if (storedCredential() !== undefined) {
        throw new Error(explainPasskeyError(err));
      }
      throw new NoPasskeyFoundError(
        "No hunt wallet on this phone. If you have played before, open the hunt on the phone you first signed in with — or make a new wallet below.",
        explainPasskeyError(err),
      );
    }
    await establishSession(passkey);
  } finally {
    // Zero the key as soon as we are done with it, on every path.
    passkey?.session.end();
  }
}

async function runCreateWallet(): Promise<void> {
  if (storedCredential() !== undefined) {
    throw new Error(
      "This phone already has a hunt passkey. Tap sign in to open the wallet it belongs to.",
    );
  }
  let passkey: PasskeyAccount | null = null;
  try {
    try {
      passkey = await createAccount();
    } catch (err) {
      // Only the ceremony is translated. A server refusal from
      // establishSession already carries its own words and must not be
      // relabelled as a passkey problem.
      throw new Error(explainPasskeyError(err));
    }
    await establishSession(passkey);
  } finally {
    passkey?.session.end();
  }
}

/**
 * Registered with `<Providers signer>`. Signs one claim or spawn collect.
 *
 * The passkey prompt runs per signature by design: this is the path that moves real MON,
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

/**
 * Send native MON from the player's passkey wallet.
 *
 * The one transaction a hunter ever signs themselves. Everything else in this
 * app is either an off-chain signature (a claim) or something the treasury or
 * the relayer does for them; buying an edition is the exception, because the
 * money is theirs and nobody can move it on their behalf without an allowance
 * — and an allowance on a wallet belonging to somebody who does not know what
 * one is was the shape of the v3 audit's critical finding.
 *
 * Same lifecycle as `claimSigner`: derive the key, use it, end the session in
 * a finally. Holding a key open between purchases to save a Face ID prompt
 * would trade exactly the property that makes this wallet safe.
 *
 * Returns the transaction hash. The caller hands that to the server, which
 * verifies payer, recipient, amount and confirmations on chain before any
 * licence moves — see lib/editions/payment.ts.
 */
export async function payFromPasskey(
  to: `0x${string}`,
  valueWei: bigint,
): Promise<`0x${string}`> {
  let passkey: PasskeyAccount | null = null;
  try {
    passkey = await signInAccount();
    const wallet = createWalletClient({
      account: passkey.account,
      chain: monad,
      transport: http(monadRpcUrl()),
    });
    return await wallet.sendTransaction({
      to,
      value: valueWei,
      // Left to the node. Monad charges the full gas LIMIT with no refund, so
      // a hand-set limit is a hand-set price; the estimate for a bare
      // transfer is 21,000 and padding it would cost the hunter real MON.
      chain: monad,
    });
  } finally {
    passkey?.session.end();
  }
}
