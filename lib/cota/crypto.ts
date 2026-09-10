// Pure authenticated encryption for the keystore — AES-256-GCM, no I/O, no env,
// so the crypto is unit-testable in isolation from Prisma and the environment.
//
// Per-record scrypt salt (the master secret's entropy is not assumed), random
// IV per seal (never reused), and an AAD that binds a sealed record to a
// context (the playerId) so it cannot be replayed elsewhere. GCM authenticates:
// any tamper — wrong secret, flipped ciphertext, altered tag, mismatched AAD —
// makes `openWith` THROW, never return a wrong plaintext.

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

export interface Sealed {
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export function sealWith(
  secret: string,
  plaintext: string,
  aad: string,
): Sealed {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(secret, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ct.toString("base64"),
  };
}

export function openWith(secret: string, sealed: Sealed, aad: string): string {
  const salt = Buffer.from(sealed.salt, "base64");
  const iv = Buffer.from(sealed.iv, "base64");
  const key = scryptSync(secret, salt, 32);
  const decipher = createDecipheriv("aes-256-gcm", key, iv, {
    authTagLength: 16,
  });
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
