import { describe, it, expect, vi, afterEach } from "vitest";
import { verifyCaptcha, captchaConfigured } from "@/lib/auth/captcha";

function cloudflareSays(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    json: async () => body,
  } as unknown as Response);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("verifyCaptcha", () => {
  it("passes everything through when no secret is configured", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    expect(captchaConfigured()).toBe(false);
    // Deliberate: shipping this onto a live product with no keys must not lock
    // every player out. The route logs the difference instead.
    expect(await verifyCaptcha(undefined, null)).toEqual({
      ok: true,
      enforced: false,
    });
  });

  it("rejects a missing token once a secret is configured", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "s3cret");
    const r = await verifyCaptcha(undefined, null);
    expect(r).toEqual({ ok: false, reason: "captcha_missing" });
  });

  it("rejects an oversized token without calling Cloudflare", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "s3cret");
    const fetchMock = cloudflareSays({ success: true });
    vi.stubGlobal("fetch", fetchMock);
    const r = await verifyCaptcha("x".repeat(2049), null);
    expect(r).toEqual({ ok: false, reason: "captcha_malformed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a token Cloudflare confirms", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "s3cret");
    vi.stubGlobal("fetch", cloudflareSays({ success: true }));
    expect(await verifyCaptcha("good", "1.2.3.4")).toEqual({
      ok: true,
      enforced: true,
    });
  });

  it("rejects a token Cloudflare denies", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "s3cret");
    vi.stubGlobal("fetch", cloudflareSays({ success: false }));
    expect(await verifyCaptcha("bad", null)).toEqual({
      ok: false,
      reason: "captcha_failed",
    });
  });

  it("FAILS CLOSED when Cloudflare is unreachable", async () => {
    // The property worth protecting. A verifier that waves requests through
    // when its backend is down is a fuse an attacker can blow on purpose.
    vi.stubEnv("TURNSTILE_SECRET_KEY", "s3cret");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    expect(await verifyCaptcha("good", null)).toEqual({
      ok: false,
      reason: "captcha_unavailable",
    });
  });

  it("FAILS CLOSED on a non-200 from Cloudflare", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "s3cret");
    vi.stubGlobal("fetch", cloudflareSays({ success: true }, false));
    expect(await verifyCaptcha("good", null)).toEqual({
      ok: false,
      reason: "captcha_unavailable",
    });
  });

  it("FAILS CLOSED on an unparseable body", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "s3cret");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new SyntaxError("not json");
        },
      } as unknown as Response),
    );
    expect(await verifyCaptcha("good", null)).toEqual({
      ok: false,
      reason: "captcha_unavailable",
    });
  });

  it("sends the secret and token, and the IP only when known", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "s3cret");
    const fetchMock = cloudflareSays({ success: true });
    vi.stubGlobal("fetch", fetchMock);

    await verifyCaptcha("tok", "9.9.9.9");
    const body = fetchMock.mock.calls[0][1].body as URLSearchParams;
    expect(body.get("secret")).toBe("s3cret");
    expect(body.get("response")).toBe("tok");
    expect(body.get("remoteip")).toBe("9.9.9.9");

    await verifyCaptcha("tok", null);
    const body2 = fetchMock.mock.calls[1][1].body as URLSearchParams;
    expect(body2.has("remoteip")).toBe(false);
  });
});
