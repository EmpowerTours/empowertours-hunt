import { describe, expect, it } from "vitest";
import { openWith, sealWith } from "./crypto";

const SECRET = "x".repeat(48); // a strong master secret (>= 32)
const PLAYER = "player-abc123";
const CRED = JSON.stringify({
  apiKey: "sk-live-token",
  secretHex: "deadbeefcafe",
  account: "0x7d5be2896c49faea8746eea8b8585b46210e6853",
});

function flipFirstByte(b64: string): string {
  const buf = Buffer.from(b64, "base64");
  buf[0] = buf[0] ^ 0xff;
  return buf.toString("base64");
}

describe("keystore crypto — AES-256-GCM", () => {
  it("round-trips the credential", () => {
    const sealed = sealWith(SECRET, CRED, PLAYER);
    expect(openWith(SECRET, sealed, PLAYER)).toBe(CRED);
  });

  it("is non-deterministic — fresh salt + IV each seal", () => {
    const a = sealWith(SECRET, CRED, PLAYER);
    const b = sealWith(SECRET, CRED, PLAYER);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
    expect(a.salt).not.toBe(b.salt);
    // both still open to the same plaintext
    expect(openWith(SECRET, a, PLAYER)).toBe(openWith(SECRET, b, PLAYER));
  });

  it("fails CLOSED on the wrong master secret", () => {
    const sealed = sealWith(SECRET, CRED, PLAYER);
    expect(() => openWith("y".repeat(48), sealed, PLAYER)).toThrow();
  });

  it("fails CLOSED across players — a row can't be replayed under another AAD", () => {
    const sealed = sealWith(SECRET, CRED, PLAYER);
    expect(() => openWith(SECRET, sealed, "player-999")).toThrow();
  });

  it("fails CLOSED on tampered ciphertext", () => {
    const sealed = sealWith(SECRET, CRED, PLAYER);
    expect(() =>
      openWith(
        SECRET,
        { ...sealed, ciphertext: flipFirstByte(sealed.ciphertext) },
        PLAYER,
      ),
    ).toThrow();
  });

  it("fails CLOSED on a tampered auth tag", () => {
    const sealed = sealWith(SECRET, CRED, PLAYER);
    expect(() =>
      openWith(
        SECRET,
        { ...sealed, authTag: flipFirstByte(sealed.authTag) },
        PLAYER,
      ),
    ).toThrow();
  });

  it("fails CLOSED on a swapped salt (wrong derived key)", () => {
    const a = sealWith(SECRET, CRED, PLAYER);
    const b = sealWith(SECRET, CRED, PLAYER);
    expect(() => openWith(SECRET, { ...a, salt: b.salt }, PLAYER)).toThrow();
  });
});
