import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  clearSessionCookieHeader,
  issueSession,
  newNonce,
  readCookie,
  readSession,
  sessionCookieHeader,
} from "./mera";

const WALLET = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";
const SECRET = "a".repeat(48);

beforeEach(() => {
  process.env.AUTH_SESSION_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.AUTH_SESSION_SECRET;
});

describe("session tokens", () => {
  it("round-trips a wallet, lowercased", () => {
    const token = issueSession(WALLET);
    expect(readSession(token)).toEqual({
      ok: true,
      wallet: WALLET.toLowerCase(),
      credentialId: null,
    });
  });

  it("carries the passkey credential id when present", () => {
    const token = issueSession(WALLET, "cred-123");
    const result = readSession(token);
    expect(result.ok && result.credentialId).toBe("cred-123");
  });

  it("rejects a token signed with a different secret", () => {
    const token = issueSession(WALLET);
    process.env.AUTH_SESSION_SECRET = "b".repeat(48);
    expect(readSession(token)).toEqual({
      ok: false,
      reason: "invalid session",
    });
  });

  it("rejects a tampered payload", () => {
    // The forgery that matters: edit the wallet, keep the MAC.
    const token = issueSession(WALLET);
    const [version, payload, mac] = token.split(".");
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    decoded.w = "0x000000000000000000000000000000000000dead";
    const forged = `${version}.${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${mac}`;

    expect(readSession(forged)).toEqual({
      ok: false,
      reason: "invalid session",
    });
  });

  it("rejects an expired token", () => {
    const longAgo = Date.now() - (SESSION_TTL_SECONDS + 60) * 1000;
    const token = issueSession(WALLET, null, longAgo);
    expect(readSession(token)).toEqual({
      ok: false,
      reason: "session expired",
    });
  });

  it("rejects garbage", () => {
    for (const bad of ["", "x", "v1.", "v1.abc", "....", "v2.abc.def"]) {
      expect(readSession(bad).ok).toBe(false);
    }
  });

  it("rejects a token whose payload is not a wallet address", () => {
    const secret = process.env.AUTH_SESSION_SECRET!;
    // Build a correctly-MACed token by hand with a junk wallet, proving the
    // address check is a real check and not just a side effect of the MAC.
    const { createHmac } =
      require("node:crypto") as typeof import("node:crypto");
    const payload = Buffer.from(
      JSON.stringify({ w: "nope", iat: 1, exp: 2 ** 40 }),
    ).toString("base64url");
    const body = `v1.${payload}`;
    const mac = createHmac("sha256", secret).update(body).digest("base64url");

    expect(readSession(`${body}.${mac}`).ok).toBe(false);
  });

  it("fails closed when no secret is configured", () => {
    const token = issueSession(WALLET);
    delete process.env.AUTH_SESSION_SECRET;
    expect(readSession(token)).toEqual({
      ok: false,
      reason: "invalid session",
    });
  });

  it("refuses to mint a session with a weak secret", () => {
    process.env.AUTH_SESSION_SECRET = "short";
    expect(() => issueSession(WALLET)).toThrow();
  });

  it("refuses to mint a session for a non-address", () => {
    expect(() => issueSession("bob")).toThrow();
  });
});

describe("session cookie", () => {
  it("is HttpOnly and SameSite=Lax", () => {
    // HttpOnly is the property Privy's cookie lacks, which is why an XSS there
    // yields a replayable bearer token.
    const header = sessionCookieHeader(issueSession(WALLET));
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain(`${SESSION_COOKIE}=`);
    expect(header).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
  });

  it("clears with Max-Age=0", () => {
    expect(clearSessionCookieHeader()).toContain("Max-Age=0");
  });
});

describe("readCookie", () => {
  function reqWith(cookie: string): Request {
    return new Request("https://hunt.example/api/x", {
      headers: { cookie },
    });
  }

  it("reads a value among several cookies", () => {
    const req = reqWith(`a=1; ${SESSION_COOKIE}=tok123; b=2`);
    expect(readCookie(req, SESSION_COOKIE)).toBe("tok123");
  });

  it("does not match on a prefix", () => {
    const req = reqWith(`x_${SESSION_COOKIE}=wrong; ${SESSION_COOKIE}=right`);
    expect(readCookie(req, SESSION_COOKIE)).toBe("right");
  });

  it("returns null when absent or when there is no cookie header", () => {
    expect(readCookie(reqWith("a=1"), SESSION_COOKIE)).toBeNull();
    expect(
      readCookie(new Request("https://hunt.example/"), SESSION_COOKIE),
    ).toBeNull();
  });
});

describe("newNonce", () => {
  it("produces nonces the verifier accepts and never repeats", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const n = newNonce();
      expect(n).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
      expect(seen.has(n)).toBe(false);
      seen.add(n);
    }
  });
});
