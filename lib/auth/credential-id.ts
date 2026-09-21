// ---------------------------------------------------------------------------
// Is this remembered credential id one mera could actually decode?
//
// WHY THIS IS ITS OWN FILE. passkey.ts imports mera, a browser library, so the
// tests deliberately do not import it (see rpId.test.ts). This predicate is the
// part worth testing at a boundary, so it lives where a test can reach it.
//
// WHAT IT GUARDS. mera decodes `credential.credentialId` as CANONICAL unpadded
// base64url with at least one byte, and rejects anything else at the input
// boundary — synchronously, before any WebAuthn prompt, as `INPUT_INVALID`.
// Observed in production on cota.empowertours.xyz: a junk id left in the
// cross-subdomain cookie by an automated session made every sign-in fail with
// the bare text "Passkey error (INPUT_INVALID)". Nothing in the UI could clear
// it — the cookie is scoped to the parent domain, so it outlives a reload and
// outlives clearing this origin's localStorage.
//
// "Canonical" is the part that is easy to get wrong, and getting it wrong is
// how the real poison value slipped through a first attempt at this check:
// `TESTCRED123` uses only base64url characters and has a plausible length, but
// its final character carries non-zero bits beyond the last whole byte, so a
// canonical decoder refuses it. The length check alone is not enough.
//
// This mirrors mera's rule from the outside, so it can in principle drift from
// it. That is why signInAccount ALSO recovers from INPUT_INVALID at runtime:
// this predicate keeps the bad value from being read back and re-shared, and
// the catch is what saves a player if the rule ever tightens further.
// ---------------------------------------------------------------------------

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Bits the final character contributes beyond the last whole byte. */
const LEFTOVER_MASK: Record<number, number> = {
  // 2 chars -> 12 bits -> 1 byte, 4 bits left over.
  2: 0b1111,
  // 3 chars -> 18 bits -> 2 bytes, 2 bits left over.
  3: 0b11,
};

function base64UrlValue(char: string): number {
  const code = char.charCodeAt(0);
  if (code >= 65 && code <= 90) return code - 65; // A-Z
  if (code >= 97 && code <= 122) return code - 97 + 26; // a-z
  if (code >= 48 && code <= 57) return code - 48 + 52; // 0-9
  if (char === "-") return 62;
  return 63; // "_", the only character left that BASE64URL admits
}

/**
 * True when `credentialId` is canonical unpadded base64url of at least one
 * byte — the exact shape mera accepts.
 */
export function isUsableCredentialId(credentialId: string): boolean {
  // Empty decodes cleanly to zero bytes, which mera rejects on minByteLength.
  if (credentialId.length === 0) return false;
  // 6 bits cannot be a prefix of any byte, so this length is not an encoding.
  if (credentialId.length % 4 === 1) return false;
  if (!BASE64URL.test(credentialId)) return false;

  const mask = LEFTOVER_MASK[credentialId.length % 4];
  if (mask === undefined) return true; // a whole number of bytes, nothing over
  const last = base64UrlValue(credentialId[credentialId.length - 1]!);
  // Non-zero leftover bits mean a decoder that checks canonicity will refuse
  // it, even though every character is in the alphabet.
  return (last & mask) === 0;
}
