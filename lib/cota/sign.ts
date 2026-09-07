"use client";

// ---------------------------------------------------------------------------
// Signing a Cota in the browser.
//
// Deliberately mirrors `claimSigner` in lib/auth/signIn.ts: open the passkey,
// sign one thing, end the session on every path. Face ID runs per signature and
// the key is zeroed immediately, because a key held open to save a prompt gives
// up exactly the property the signature exists to provide.
//
// A Cota is the one signature in this app that authorises somebody ELSE to act
// later. That makes the prompt more important, not less — it is the moment the
// player is actually agreeing, and it should cost a deliberate gesture.
// ---------------------------------------------------------------------------

import type { Hex } from "viem";
import { signInAccount, type PasskeyAccount } from "@/lib/auth/passkey";
import {
  COTA_TYPES,
  HUNT_DOMAIN,
  cotaDigest,
  type CotaMessage,
} from "./typedData";
import { anchorLeashWithAccount } from "./anchor";

/**
 * A fresh nonce in the format lib/auth/eip712.ts accepts (`[A-Za-z0-9_-]{16,128}`).
 *
 * Web Crypto rather than node's randomBytes: lib/auth/mera.ts owns the server
 * generator and importing it here would drag node crypto into the bundle.
 */
export function newBrowserNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Sign one Cota with the player's passkey.
 *
 * Returns the signature only. The caller keeps the message it built and sends
 * both, so the server verifies the numbers it was given rather than trusting a
 * shape this function chose — the signature is worthless if the server is
 * allowed to re-derive what was signed.
 */
export async function signCota(message: CotaMessage): Promise<Hex> {
  let passkey: PasskeyAccount | null = null;
  try {
    passkey = await signInAccount();
    return await passkey.account.signTypedData({
      domain: HUNT_DOMAIN,
      types: COTA_TYPES,
      primaryType: "Cota",
      message: {
        venue: message.venue,
        // Spread into a mutable array: viem's typed-data encoder takes
        // string[], and a readonly tuple does not satisfy it.
        markets: [...message.markets],
        maxNotionalUsdE6: message.maxNotionalUsdE6,
        maxLeverageX100: message.maxLeverageX100,
        maxDailyLossUsdE6: message.maxDailyLossUsdE6,
        maxTradesPerDay: message.maxTradesPerDay,
        notBefore: message.notBefore,
        notAfter: message.notAfter,
        clientTs: message.clientTs,
        nonce: message.nonce,
      },
    });
  } finally {
    passkey?.session.end();
  }
}

/**
 * Sign a Cota AND anchor it on Monad in one passkey session.
 *
 * One Face ID covers both: the EIP-712 signature and the anchor transaction are
 * both local secp256k1 operations on the same in-memory key, so opening the
 * passkey once is enough. The hunter pays the small anchor fee from their own
 * wallet — their leash chains under their own address, no platform wallet.
 *
 * Anchoring is best-effort: if it throws, the signature still stands and is
 * returned, and the leash is simply stored un-anchored (anchorTxHash null).
 */
export async function signAndAnchorCota(
  message: CotaMessage,
): Promise<{ signature: Hex; anchorTxHash: `0x${string}` | null }> {
  let passkey: PasskeyAccount | null = null;
  try {
    passkey = await signInAccount();
    const signature = await passkey.account.signTypedData({
      domain: HUNT_DOMAIN,
      types: COTA_TYPES,
      primaryType: "Cota",
      message: {
        venue: message.venue,
        markets: [...message.markets],
        maxNotionalUsdE6: message.maxNotionalUsdE6,
        maxLeverageX100: message.maxLeverageX100,
        maxDailyLossUsdE6: message.maxDailyLossUsdE6,
        maxTradesPerDay: message.maxTradesPerDay,
        notBefore: message.notBefore,
        notAfter: message.notAfter,
        clientTs: message.clientTs,
        nonce: message.nonce,
      },
    });

    let anchorTxHash: `0x${string}` | null = null;
    try {
      const res = await anchorLeashWithAccount(
        passkey.account,
        cotaDigest(message),
        signature,
      );
      if ("txHash" in res) anchorTxHash = res.txHash;
    } catch (anchorErr) {
      // The signature is valid regardless; leave the leash un-anchored.
      console.error("[cota] anchor failed (leash still signed)", anchorErr);
    }

    return { signature, anchorTxHash };
  } finally {
    passkey?.session.end();
  }
}
