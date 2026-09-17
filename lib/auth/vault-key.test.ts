import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import {
  HUNT_VAULT_SALT,
  HUNT_VAULT_SALT_LABEL,
  openNote,
  sealNote,
  vaultKeyFromPrfOutput,
} from "./vault-key";
import { HUNT_PRF_SALT, HUNT_PRF_SALT_LABEL } from "./derive";
import { bytesToHex } from "viem";

// jsdom/node need a WebCrypto on the global for subtle.
if (!globalThis.crypto?.subtle) {
  // @ts-expect-error assigning the node implementation for the test env
  globalThis.crypto = webcrypto;
}

const PRF = new Uint8Array(32).fill(7);
const DIGEST = `0x${"ab".repeat(32)}`;

describe("domain separation from the wallet", () => {
  it("the vault salt is a DIFFERENT salt from the wallet's", () => {
    // Same face, same origin, unrelated bytes. If these ever collide, the
    // encryption key and the signing key become the same secret and a flaw in
    // either leaks both.
    expect(HUNT_VAULT_SALT_LABEL).not.toBe(HUNT_PRF_SALT_LABEL);
    expect(bytesToHex(HUNT_VAULT_SALT)).not.toBe(bytesToHex(HUNT_PRF_SALT));
  });

  it("pins the salt bytes, so changing the label fails here", () => {
    // Changing it orphans every note ever sealed. That must be a deliberate
    // act with a test to update, not a rename nobody notices.
    expect(HUNT_VAULT_SALT_LABEL).toBe("empowertours-hunt/passkey/vault/v1");
    expect(bytesToHex(HUNT_VAULT_SALT)).toHaveLength(66);
  });
});

describe("the key cannot be exported", () => {
  it("refuses to hand the bytes back to any script, including ours", async () => {
    // extractable:false is what makes "the server cannot read it" true even in
    // the presence of a bug that tries to upload it.
    const key = await vaultKeyFromPrfOutput(PRF);
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });

  it("refuses PRF output that is not 32 bytes", async () => {
    await expect(vaultKeyFromPrfOutput(new Uint8Array(16))).rejects.toThrow();
  });
});

describe("seal and open", () => {
  it("round-trips a note", async () => {
    const key = await vaultKeyFromPrfOutput(PRF);
    const sealed = await sealNote(key, "sold too early again", DIGEST);
    expect(sealed.ciphertext).not.toContain("sold");
    expect(await openNote(key, sealed, DIGEST)).toBe("sold too early again");
  });

  it("uses a fresh IV every time", async () => {
    // GCM with a reused IV under one key is catastrophic, and this key is
    // stable for the life of the passkey — the IV is the only thing keeping two
    // notes apart.
    const key = await vaultKeyFromPrfOutput(PRF);
    const ivs = new Set<string>();
    for (let i = 0; i < 25; i++) {
      ivs.add((await sealNote(key, "same text", DIGEST)).iv);
    }
    expect(ivs.size).toBe(25);
  });

  it("a different face cannot open it", async () => {
    const mine = await vaultKeyFromPrfOutput(PRF);
    const theirs = await vaultKeyFromPrfOutput(new Uint8Array(32).fill(9));
    const sealed = await sealNote(mine, "private", DIGEST);
    await expect(openNote(theirs, sealed, DIGEST)).rejects.toThrow();
  });

  it("a note moved onto another leash fails to open", async () => {
    // The aad binds ciphertext to the bound it was written about.
    const key = await vaultKeyFromPrfOutput(PRF);
    const sealed = await sealNote(key, "about THIS leash", DIGEST);
    await expect(
      openNote(key, sealed, `0x${"cd".repeat(32)}`),
    ).rejects.toThrow();
  });

  it("tampering throws rather than returning plausible text", async () => {
    const key = await vaultKeyFromPrfOutput(PRF);
    const sealed = await sealNote(key, "untouched", DIGEST);
    const bytes = atob(sealed.ciphertext).split("");
    bytes[0] = String.fromCharCode(bytes[0].charCodeAt(0) ^ 0xff);
    await expect(
      openNote(key, { ...sealed, ciphertext: btoa(bytes.join("")) }, DIGEST),
    ).rejects.toThrow();
  });
});
