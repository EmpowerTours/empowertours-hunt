// A second thing derived from the same face — and it is not a wallet.
//
// The passkey's PRF gives 32 bytes that are stable for one credential, one
// origin and one salt, forever. Hunt already turns those bytes into a wallet.
// Change the salt and the same face yields a completely unrelated 32 bytes, so
// one authenticator can back several independent secrets without the hunter
// managing any of them.
//
// This derives an AES-256-GCM key for the hunter's own records. It exists
// because of a gap Cota otherwise has: a leash is signed and anchored, and the
// agent's decisions are logged — but that log lives in a database the hunter
// does not control, describing trades they made with money they own. They can
// read it because we let them. That is the ordinary arrangement and it is worth
// refusing.
//
// With this key, a hunter's private notes on a leash are sealed in the browser
// and stored as ciphertext the server cannot open. Not "will not" — cannot. The
// key never leaves the page, is never uploaded, and cannot be recovered from the
// database, from a backup, or by us under any instruction.
//
// ## Why a different salt rather than reusing the wallet key
//
// Domain separation is the entire point. An encryption key that IS the signing
// key means any flaw that leaks one leaks the other, and it would let a
// signature request double as a decryption oracle. The two derivations share a
// face and nothing else: knowing either tells you nothing about the other,
// because SHA-256 stands between them.
//
// ## What is lost, said plainly
//
// There is no recovery. Lose the passkey and the ciphertext is noise forever —
// no reset, no support route, no backdoor, by construction. That is the trade
// for a server that genuinely cannot read it, and it is why this is used for the
// hunter's own notes rather than for anything the system needs to function.

import { sha256 } from "viem";
import { stringToBytes } from "viem";

/**
 * Salt label for the vault key. Distinct from HUNT_PRF_SALT_LABEL, and the
 * difference is load-bearing: same authenticator, same origin, unrelated bytes.
 *
 * Versioned like the wallet salt. Changing it orphans every existing sealed
 * note, so it is pinned in a test rather than trusted to review.
 */
export const HUNT_VAULT_SALT_LABEL = "empowertours-hunt/passkey/vault/v1";
export const HUNT_VAULT_SALT: Uint8Array = sha256(
  stringToBytes(HUNT_VAULT_SALT_LABEL),
  "bytes",
);

export interface SealedNote {
  /** base64 */
  iv: string;
  /** base64 */
  ciphertext: string;
}

/**
 * Import 32 PRF bytes as a non-extractable AES-256-GCM key.
 *
 * `extractable: false` is deliberate: the browser will encrypt and decrypt with
 * it and will not hand the bytes back to any script, including ours. A bug that
 * tries to upload the key cannot succeed.
 */
export async function vaultKeyFromPrfOutput(
  prfOutput: Uint8Array,
): Promise<CryptoKey> {
  if (prfOutput.length !== 32) {
    throw new Error(
      `expected 32 bytes of PRF output, got ${String(prfOutput.length)}`,
    );
  }
  return crypto.subtle.importKey(
    "raw",
    prfOutput as unknown as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Seal a note. A fresh random IV every time — GCM with a reused IV under the
 * same key is catastrophic rather than merely weak, and the key here is stable
 * for the life of the passkey, so the IV is the only thing keeping two notes
 * apart.
 *
 * `aad` binds the ciphertext to a context, normally the leash digest. A note
 * moved onto another leash then fails to open rather than decrypting under a
 * bound it was not written about.
 */
export async function sealNote(
  key: CryptoKey,
  plaintext: string,
  aad: string,
): Promise<SealedNote> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv as unknown as BufferSource,
      additionalData: enc.encode(aad) as unknown as BufferSource,
    },
    key,
    enc.encode(plaintext) as unknown as BufferSource,
  );
  return { iv: b64(iv), ciphertext: b64(new Uint8Array(ct)) };
}

/**
 * Open a note, or throw.
 *
 * GCM authenticates, so a wrong key, a tampered ciphertext, a swapped IV or a
 * mismatched aad all THROW rather than returning plausible wrong text. There is
 * no path here that quietly returns something the hunter did not write.
 */
export async function openNote(
  key: CryptoKey,
  sealed: SealedNote,
  aad: string,
): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: unb64(sealed.iv) as unknown as BufferSource,
      additionalData: enc.encode(aad) as unknown as BufferSource,
    },
    key,
    unb64(sealed.ciphertext) as unknown as BufferSource,
  );
  return dec.decode(pt);
}
