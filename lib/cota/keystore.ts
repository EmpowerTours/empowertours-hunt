// Server-side custody of a hunter's Perpl trading key.
//
// The key is held so the Cota agent can execute bounded trades for a hunter.
// Safe by construction: a Perpl trading key can TRADE but never WITHDRAW (the
// venue enforces this), and every order the agent places is leash-gated
// (enforce.ts) + anchored. So even a full database compromise cannot move a
// hunter's money — only trade within a leash they signed. This is the trust
// model chosen deliberately over browser-only keys, which cannot support an
// autonomous agent.
//
// Encryption: AES-256-GCM. The key is derived per-record with scrypt from
// COTA_KEY_ENC_SECRET and a random salt, so the master secret's entropy is not
// assumed and two records never share a key. The playerId is the GCM AAD, so a
// sealed row is bound to its player and cannot be replayed under another.
//
// SERVER ONLY: reads COTA_KEY_ENC_SECRET and node:crypto. Never import client-side.

import { prisma } from "@/lib/db/prisma";
import { openWith, sealWith } from "./crypto";

/** The plaintext under seal: the enrolled Perpl credential. */
export interface PerpCredential {
  /** The X-API-Key token. */
  apiKey: string;
  /** The Ed25519 signing secret, hex. */
  secretHex: string;
  /** The Perpl account / wallet address it trades for. */
  account: string;
}

function masterSecret(): string {
  const s = process.env.COTA_KEY_ENC_SECRET;
  // A short/absent secret is a misconfiguration that would silently weaken every
  // sealed key — refuse rather than encrypt under a guessable secret.
  if (!s || s.length < 32) {
    throw new Error(
      "COTA_KEY_ENC_SECRET is not set or too short (need a strong random value, >= 32 chars)",
    );
  }
  return s;
}

/** Store (or replace) a player's Perpl credential, sealed. */
export async function storePerpKey(
  playerId: string,
  cred: PerpCredential,
): Promise<void> {
  const sealed = sealWith(masterSecret(), JSON.stringify(cred), playerId);
  await prisma.perpKey.upsert({
    where: { playerId },
    create: {
      playerId,
      account: cred.account,
      salt: sealed.salt,
      iv: sealed.iv,
      authTag: sealed.authTag,
      ciphertext: sealed.ciphertext,
    },
    update: {
      account: cred.account,
      salt: sealed.salt,
      iv: sealed.iv,
      authTag: sealed.authTag,
      ciphertext: sealed.ciphertext,
    },
  });
}

/** Load and unseal a player's Perpl credential, or null if none is stored. */
export async function loadPerpKey(
  playerId: string,
): Promise<PerpCredential | null> {
  const row = await prisma.perpKey.findUnique({ where: { playerId } });
  if (!row) return null;
  const json = openWith(
    masterSecret(),
    {
      salt: row.salt,
      iv: row.iv,
      authTag: row.authTag,
      ciphertext: row.ciphertext,
    },
    playerId,
  );
  return JSON.parse(json) as PerpCredential;
}

/** Whether a player has a stored trading key (no decryption). */
export async function hasPerpKey(playerId: string): Promise<boolean> {
  const row = await prisma.perpKey.findUnique({
    where: { playerId },
    select: { id: true },
  });
  return row !== null;
}
