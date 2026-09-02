"use client";

import {
  createPasskeyWithPrfOutput,
  createSecp256k1SigningSession,
  getEvmAddress,
  getPasskeyPrfOutput,
  isMeraError,
  type PasskeyCredentialMetadata,
  type Secp256k1SigningSession,
} from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import type { LocalAccount } from "viem";
import { HUNT_PRF_SALT, walletFromPrfOutput } from "./derive";

// ---------------------------------------------------------------------------
// The WebAuthn half of player auth. Browser only — mera is a browser library
// and there is no server SDK, which is why `lib/auth/mera.ts` verifies a
// signature rather than calling anything from here.
//
// Face ID reproduces the same 32 PRF bytes for the same (credential, rpId,
// salt) forever, so the same face on the same account is always the same
// wallet. Nothing here reaches a server: the key is derived, used, and zeroed
// in the page.
// ---------------------------------------------------------------------------

/** Must equal the host the app is served from, or WebAuthn refuses the ceremony. */
export const RP_ID = process.env.NEXT_PUBLIC_RP_ID ?? "localhost";

/**
 * Hunt wallets must never be Regalo wallets.
 *
 * Two mechanisms keep them apart — a different relying-party id and a different
 * PRF salt (see HUNT_PRF_SALT) — and both are configuration, so both can be got
 * wrong. Serving hunt from Regalo's host would silently hand every player the
 * wallet they use for gift links: same face, same credential, and only the salt
 * left standing between two apps' balances.
 *
 * A comment does not stop that; this does. Encoded as a check because a rule
 * nobody can run is not a control.
 */
const FOREIGN_RP_IDS = ["regalo.empowertours.xyz"];

function assertOwnRelyingParty(rpId: string): void {
  if (FOREIGN_RP_IDS.includes(rpId.toLowerCase())) {
    throw new Error(
      `NEXT_PUBLIC_RP_ID is set to ${rpId}, which belongs to another EmpowerTours app. ` +
        "Hunt passkeys must be issued under hunt's own host or players share wallets between apps.",
    );
  }
}

/**
 * WebAuthn's own timeout is only a hint and some platforms ignore it, so the
 * ceremony is also raced against a hard guard. Without this the promise can
 * simply never settle, and a player who opened the page on a device that does
 * not hold their passkey sits on a spinner with nothing to tap.
 */
const CEREMONY_TIMEOUT_MS = 60_000;
const HARD_GUARD_MS = CEREMONY_TIMEOUT_MS + 15_000;

const CREDENTIAL_KEY = "hunt.passkey.credential";

class CeremonyTimeout extends Error {
  constructor() {
    super("ceremony timed out");
    this.name = "CeremonyTimeout";
  }
}

async function withGuard<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new CeremonyTimeout());
    }, HARD_GUARD_MS);
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface PasskeyAccount {
  account: LocalAccount;
  session: Secp256k1SigningSession;
  /** BIP-39 phrase for this wallet, so a player can take a payout elsewhere. */
  mnemonic: string;
  /** Base64url credential id, sent to the server so it can bind it to the row. */
  credentialId: string;
}

export function storedCredential(): PasskeyCredentialMetadata | undefined {
  try {
    const raw = localStorage.getItem(CREDENTIAL_KEY);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "credentialId" in parsed &&
      typeof (parsed as { credentialId: unknown }).credentialId === "string"
    ) {
      return parsed as PasskeyCredentialMetadata;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function rememberCredential(credential: PasskeyCredentialMetadata): void {
  try {
    localStorage.setItem(
      CREDENTIAL_KEY,
      JSON.stringify({
        credentialId: credential.credentialId,
        transports: credential.transports,
      }),
    );
  } catch {
    // Private browsing can refuse storage. The passkey still works; the browser
    // will offer a chooser next time instead of going straight in.
  }
}

function accountFromPrfOutput(
  prfOutput: Uint8Array,
  credentialId: string,
): PasskeyAccount {
  const { mnemonic, privateKey } = walletFromPrfOutput(prfOutput);
  const session = createSecp256k1SigningSession({ privateKey });
  const account = toViemAccount(session);

  // mera's address helper and viem's adapter must agree, or something upstream
  // changed and we should fail loudly rather than register the wrong address as
  // a player and strand their credit there.
  if (
    getEvmAddress(session.publicKey).toLowerCase() !==
    account.address.toLowerCase()
  ) {
    session.end();
    throw new Error("address mismatch between mera and viem");
  }

  return { account, session, mnemonic, credentialId };
}

/** First visit on this device: make a passkey and the wallet behind it. */
export async function createAccount(
  displayName = "Hunt wallet",
): Promise<PasskeyAccount> {
  assertOwnRelyingParty(RP_ID);
  const created = await withGuard(
    createPasskeyWithPrfOutput({
      rp: { id: RP_ID, name: "EmpowerTours Hunt" },
      user: { name: displayName, displayName },
      prfSalt: HUNT_PRF_SALT,
      timeout: CEREMONY_TIMEOUT_MS,
    }),
  );
  rememberCredential(created);
  return accountFromPrfOutput(created.prfOutput, created.credentialId);
}

/**
 * Returning player: same passkey, same 32 bytes, same address.
 *
 * With no locally-known credential this still runs, and the platform offers any
 * discoverable passkey for this relying party — which is how a player who
 * cleared storage, or arrived on a second device synced to the same iCloud
 * Keychain or Google Password Manager, gets back into the SAME wallet rather
 * than silently being given a new one.
 */
export async function signInAccount(): Promise<PasskeyAccount> {
  assertOwnRelyingParty(RP_ID);
  const known = storedCredential();
  const { prfOutput, credentialId } = await withGuard(
    getPasskeyPrfOutput({
      rpId: RP_ID,
      credential: known,
      prfSalt: HUNT_PRF_SALT,
      timeout: CEREMONY_TIMEOUT_MS,
    }),
  );
  rememberCredential(
    known?.credentialId === credentialId ? known : { credentialId },
  );
  return accountFromPrfOutput(prfOutput, credentialId);
}

/** Turn a mera failure into something a player standing outdoors can act on. */
export function explainPasskeyError(err: unknown): string {
  if (err instanceof CeremonyTimeout) {
    return "Nothing answered the Face ID request. If this device doesn't hold your passkey, open the hunt on the phone you first signed in with.";
  }
  if (isMeraError(err)) {
    switch (err.code) {
      case "PRF_UNAVAILABLE":
        // mera's verified support matrix. Being specific matters: someone hits
        // this outdoors, mid-hunt, with no one to ask.
        return "This device can't make a hunt wallet. On iPhone: use Safari with iCloud Keychain on, and update iOS if it's several years old. On Android: use Chrome signed in to Google Password Manager. 1Password works too. Bitwarden and Dashlane don't yet.";
      case "PASSKEY_OPERATION_FAILED":
        return "The Face ID / fingerprint prompt was cancelled or unavailable. Tap sign in again.";
      case "CRYPTO_UNAVAILABLE":
        return "This page must be opened over HTTPS for passkeys to work.";
      default:
        return `Passkey error (${err.code}).`;
    }
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}
