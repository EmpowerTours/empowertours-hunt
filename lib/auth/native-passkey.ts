"use client";

import { inAppWebView } from "@/lib/app-shell";

/* ---------------------------------------------------------------------------
   The Credential Manager road, reached from a page.

   The app's WebView does WebAuthn through Play services' FIDO2 APIs, and on
   some devices that road is broken while Credential Manager — the one Chrome
   uses on the same phone, with the same passkey — works. Measured on a vivo
   running OriginOS 6: NotReadableError in three seconds from the WebView, a
   working sign-in from Chrome.

   NativePasskeyPlugin (mobile/android/.../NativePasskeyPlugin.java) runs the
   assertion natively down that other road. This is the page's side of it.

   It is a FALLBACK and stays one. The WebView path works on other Android
   phones and is the one Google maintains; replacing it everywhere to fix one
   device would be trading a known-good path for a less-travelled one.
--------------------------------------------------------------------------- */

interface CapacitorBridge {
  nativePromise?: (
    plugin: string,
    method: string,
    options: Record<string, unknown>,
  ) => Promise<unknown>;
}

function bridge(): CapacitorBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as { Capacitor?: CapacitorBridge }).Capacitor;
}

/** base64url, no padding — the encoding WebAuthn's JSON form uses throughout. */
function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Is the native road available at all?
 *
 * Asks the plugin rather than inferring from the user agent: an older installed
 * APK has the bridge but not this plugin, and a device can have Capacitor and
 * no working Credential Manager. Both answer "no" here instead of failing
 * halfway through a ceremony.
 */
export async function nativePasskeyAvailable(): Promise<boolean> {
  if (!inAppWebView()) return false;
  const cap = bridge();
  if (cap?.nativePromise === undefined) return false;
  try {
    const res = (await cap.nativePromise(
      "NativePasskey",
      "isAvailable",
      {},
    )) as {
      available?: unknown;
    };
    return res?.available === true;
  } catch {
    // An APK from before this plugin existed rejects with "not implemented".
    return false;
  }
}

export interface NativePrfResult {
  prfOutput: Uint8Array;
  credentialId: string;
}

/**
 * Run a discoverable assertion natively and return the PRF output.
 *
 * The challenge is random and unverified, deliberately: nothing downstream
 * checks this assertion. The server authenticates an EIP-712 signature from the
 * derived key, so what is needed from the ceremony is the PRF bytes and the
 * credential id — the same thing the WebView path yields.
 */
export async function getPrfViaNative(args: {
  rpId: string;
  prfSalt: Uint8Array;
  /** Narrows the lookup when this device already knows which credential. */
  credentialId?: string;
  timeoutMs?: number;
}): Promise<NativePrfResult> {
  const cap = bridge();
  if (cap?.nativePromise === undefined) {
    throw new Error("native bridge unavailable");
  }

  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);

  const requestJson = JSON.stringify({
    challenge: toBase64Url(challenge),
    rpId: args.rpId,
    userVerification: "required",
    timeout: args.timeoutMs ?? 60_000,
    allowCredentials:
      args.credentialId === undefined
        ? []
        : [{ type: "public-key", id: args.credentialId }],
    extensions: { prf: { eval: { first: toBase64Url(args.prfSalt) } } },
  });

  const res = (await cap.nativePromise("NativePasskey", "get", {
    requestJson,
  })) as { responseJson?: unknown };

  if (typeof res?.responseJson !== "string") {
    throw new Error("native passkey returned no response");
  }

  const parsed = JSON.parse(res.responseJson) as {
    id?: string;
    clientExtensionResults?: { prf?: { results?: { first?: string } } };
  };

  const first = parsed.clientExtensionResults?.prf?.results?.first;
  if (typeof first !== "string" || parsed.id === undefined) {
    // The assertion succeeded and the extension was dropped. Saying so exactly
    // matters: it is the difference between "this device cannot sign in" and
    // "this device signed in and cannot derive the wallet", and only the second
    // means the road is a dead end for us.
    throw new Error(
      "The passkey worked but this device did not evaluate PRF, so the wallet cannot be derived here.",
    );
  }

  const prfOutput = fromBase64Url(first);
  if (prfOutput.length < 32) {
    throw new Error(`PRF output too short (${prfOutput.length} bytes)`);
  }

  return { prfOutput, credentialId: parsed.id };
}

export interface NativeAppInfo {
  versionName?: string;
  versionCode?: number;
  hasAssetStatementsMetaData?: boolean;
  assetStatements?: string;
}

/**
 * What the installed APK declares about itself.
 *
 * "RP ID cannot be validated" looks identical whether the app is missing its
 * asset statements or the device is refusing statements that are present. The
 * page cannot read a manifest, so the app reports its own.
 */
export async function nativeAppInfo(): Promise<NativeAppInfo | null> {
  const cap = bridge();
  if (cap?.nativePromise === undefined) return null;
  try {
    return (await cap.nativePromise(
      "NativePasskey",
      "appInfo",
      {},
    )) as NativeAppInfo;
  } catch {
    return null;
  }
}
