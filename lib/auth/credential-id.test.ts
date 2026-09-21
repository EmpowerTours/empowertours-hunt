import { describe, expect, it } from "vitest";
import { isUsableCredentialId } from "./credential-id";

// The oracle these cases were checked against is a canonical unpadded base64url
// decoder (@scure/base's `base64urlnopad`, which is what mera decodes with).
// The predicate was compared with it over 4000 generated strings plus the table
// below and agreed on every one; the interesting cases are pinned here so a
// later edit that loosens the rule fails rather than silently re-admitting the
// value that caused the outage.

describe("ids a canonical decoder accepts", () => {
  it.each(["AA", "AAA", "AAAA", "ab-_", "AQ", "Aw"])("accepts %o", (id) => {
    expect(isUsableCredentialId(id)).toBe(true);
  });

  it("accepts a realistic 16-byte credential id", () => {
    expect(isUsableCredentialId("AAECAwQFBgcICQoLDA0ODw")).toBe(true);
  });
});

describe("ids mera rejects at the input boundary", () => {
  // This is the value that actually shipped a broken sign-in: it sat in the
  // cross-subdomain cookie and every attempt died as "Passkey error
  // (INPUT_INVALID)" before any passkey sheet appeared.
  it("rejects the id observed in production", () => {
    expect(isUsableCredentialId("TESTCRED123")).toBe(false);
  });

  it("rejects it for the RIGHT reason — not its characters or its length", () => {
    // Every character is in the base64url alphabet...
    expect(/^[A-Za-z0-9_-]+$/.test("TESTCRED123")).toBe(true);
    // ...and 11 is a length an unpadded encoding can have.
    expect("TESTCRED123".length % 4).not.toBe(1);
    // It fails only because the final character carries bits past the last
    // whole byte. A check that stopped at charset and length would let it
    // through, which is exactly what a first attempt at this did.
    expect(isUsableCredentialId("TESTCRED12A")).toBe(true);
  });

  it("rejects an empty id, which decodes to zero bytes", () => {
    expect(isUsableCredentialId("")).toBe(false);
  });

  it("rejects a length no unpadded encoding can have", () => {
    expect(isUsableCredentialId("A")).toBe(false);
    expect(isUsableCredentialId("AAAAA")).toBe(false);
  });

  it("rejects padding, which is not canonical here", () => {
    expect(isUsableCredentialId("AA==")).toBe(false);
  });

  it("rejects characters outside the alphabet", () => {
    expect(isUsableCredentialId("sp ace")).toBe(false);
    expect(isUsableCredentialId("a+b/")).toBe(false);
  });

  it("rejects non-zero leftover bits at both group lengths", () => {
    // 2 chars -> 1 byte, 4 bits over.
    expect(isUsableCredentialId("Ah")).toBe(false);
    expect(isUsableCredentialId("AA")).toBe(true);
    // 3 chars -> 2 bytes, 2 bits over.
    expect(isUsableCredentialId("AAB")).toBe(false);
    expect(isUsableCredentialId("AAA")).toBe(true);
  });
});
