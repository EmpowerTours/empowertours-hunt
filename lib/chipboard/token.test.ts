import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MIN_SECRET_LEN,
  mintToken,
  sessionSecret,
  validPlayerId,
} from "./token";

// The vectors were produced by the Go server's own auth.HMAC.Mint, and the Go
// test TestSharedTokenVectors checks the same file. A token the server rejects
// closes every connection with 4003 and nothing else says why, so this is the
// contract test between the two languages.
const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../services/chipboard/internal/auth/testdata/token_vectors.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
) as {
  secret: string;
  vectors: Array<{ playerId: string; expiry: number; token: string }>;
};

describe("chipboard tokens", () => {
  it("mints exactly what the Go server mints", () => {
    expect(fixture.vectors.length).toBeGreaterThan(0);
    for (const v of fixture.vectors)
      expect(mintToken(v.playerId, v.expiry, fixture.secret)).toBe(v.token);
  });

  it("produces a 43-char unpadded base64url signature", () => {
    const tok = mintToken("ana", 1_800_003_600, fixture.secret);
    const [, , sig] = tok.split(".");
    expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("changes the signature with the secret, the id and the expiry", () => {
    const base = mintToken("ana", 1_800_003_600, fixture.secret);
    expect(mintToken("ana", 1_800_003_600, "x".repeat(32))).not.toBe(base);
    expect(mintToken("anb", 1_800_003_600, fixture.secret)).not.toBe(base);
    expect(mintToken("ana", 1_800_003_601, fixture.secret)).not.toBe(base);
  });

  it("refuses ids the server would refuse, and short secrets", () => {
    for (const bad of ["", "a.b", "a b", "x".repeat(65), "ñ"])
      expect(() => mintToken(bad, 1_800_000_000, fixture.secret)).toThrow();
    expect(validPlayerId("cmh3k9x2a0000qz8v7y1b2c3d")).toBe(true);
    expect(() => mintToken("ana", 1_800_000_000, "short")).toThrow();
    expect(() => mintToken("ana", 0, fixture.secret)).toThrow();
  });

  it("fails closed on a missing or short secret", () => {
    expect(sessionSecret({})).toBeNull();
    expect(
      sessionSecret({
        CHIPBOARD_SESSION_SECRET: "x".repeat(MIN_SECRET_LEN - 1),
      }),
    ).toBeNull();
    expect(
      sessionSecret({ CHIPBOARD_SESSION_SECRET: "x".repeat(MIN_SECRET_LEN) }),
    ).toBe("x".repeat(MIN_SECRET_LEN));
  });

  it("agrees with a plain HMAC over the payload", () => {
    const tok = mintToken("ana", 1_800_003_600, fixture.secret);
    const want = createHmac("sha256", fixture.secret)
      .update("ana.1800003600")
      .digest("base64url");
    expect(tok).toBe(`ana.1800003600.${want}`);
  });
  it("refuses the committed test secret as a real one", () => {
    expect(sessionSecret({ CHIPBOARD_SESSION_SECRET: fixture.secret })).toBe(
      null,
    );
    expect(
      sessionSecret({ CHIPBOARD_SESSION_SECRET: "r".repeat(32) }),
    ).not.toBe(null);
  });
});
