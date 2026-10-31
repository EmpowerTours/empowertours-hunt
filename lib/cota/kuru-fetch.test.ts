import { afterEach, describe, expect, it, vi } from "vitest";
import { KURU_TIMEOUT_MS, KuruUnreachable, kuruToken } from "./kuru";

const USER = "0xE2ab465839E409C80D1CA4bB4508feA7Eb808395";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// The fetch Kuru never answers: resolves only when its signal aborts.
const hangingFetch = vi.fn(
  (_url: string, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    }),
);

describe("Kuru calls give up instead of hanging (2026-10-30 outage)", () => {
  it("times out a call that never answers, as KuruUnreachable", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hangingFetch);
    const p = kuruToken(USER);
    const caught = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(KURU_TIMEOUT_MS);
    const err = await caught;
    expect(err).toBeInstanceOf(KuruUnreachable);
    expect(String(err)).toMatch(/timed out/);
  });

  it("treats a Cloudflare 522 as unreachable, not as a refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("error code: 522", { status: 522 })),
    );
    await expect(kuruToken(USER)).rejects.toBeInstanceOf(KuruUnreachable);
  });

  it("treats a network failure (Safari's 'Load failed') as unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Load failed");
      }),
    );
    await expect(kuruToken(USER)).rejects.toBeInstanceOf(KuruUnreachable);
  });

  it("leaves a 4xx as an ordinary error — Kuru answered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 429 })),
    );
    const err = await kuruToken(USER).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(KuruUnreachable);
    expect(String(err)).toMatch(/token 429/);
  });

  it("passes the caller's own cancel through unchanged", async () => {
    vi.stubGlobal("fetch", hangingFetch);
    const ctl = new AbortController();
    const p = kuruToken(USER, ctl.signal).catch((e: unknown) => e);
    ctl.abort();
    const err = await p;
    expect(err).not.toBeInstanceOf(KuruUnreachable);
    expect((err as Error).name).toBe("AbortError");
  });
});
