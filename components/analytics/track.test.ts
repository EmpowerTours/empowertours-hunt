import { beforeEach, describe, expect, it, vi } from "vitest";

// The whole point of track.ts is that call sites cannot choose what is sent,
// so these tests assert the two things a type system cannot: that the
// once-only events really fire once, and that every event carries a REDACTED
// route rather than a real URL.

const capture = vi.fn();

vi.mock("./client", () => ({
  KEY: "phc_test",
  HOST: "https://eu.i.posthog.com",
  client: () => Promise.resolve({ capture }),
  readyClient: () => ({ capture }),
  currentRoute: () => "/hunt/:id",
}));

const {
  trackActivation,
  trackCoreAction,
  trackFeature,
  trackSignup,
  trackSessionStarted,
} = await import("./track");

const flush = () => new Promise((r) => setTimeout(r, 0));

/** The vitest config runs in node on purpose, so there is no DOM. track.ts
 *  only ever touches the two storages, and a Map is a faithful enough stand-in
 *  for what it does with them. Adding jsdom for one test file would be a
 *  dependency the rest of the suite does not want. */
function storage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    clear: () => m.clear(),
  };
}

beforeEach(() => {
  capture.mockClear();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: storage(),
    sessionStorage: storage(),
  };
});

describe("activation does NOT guard itself", () => {
  it("emits whenever called — the SERVER decides what is first", async () => {
    // It used to guard with localStorage, which counted a second device twice
    // and a cleared browser again. The browser cannot know; only the server
    // can. /api/cota returns isFirstLeash and the hunt claim route returns
    // isFirstFind, each a count against that player's own rows.
    //
    // So this function is deliberately dumb, and the CALLER is responsible for
    // only invoking it when the server said so. A self-guard here would mask a
    // caller that got that wrong.
    trackActivation("leash_signed");
    trackActivation("leash_signed");
    await flush();
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls[0]![0]).toBe("activation");
    expect(capture.mock.calls[0]![1]).toMatchObject({
      jtbd_name: "leash_signed",
    });
  });

  it("carries the jtbd name it was given, Hunt or Cota", async () => {
    // One activation event across two products, distinguished by jtbd_name —
    // signing a leash on the Cota side, finding a cache on the Hunt side.
    trackActivation("cache_found");
    await flush();
    expect(capture.mock.calls[0]![1]).toMatchObject({
      jtbd_name: "cache_found",
    });
  });
});

describe("signup and session are once-only too", () => {
  it("emits signup_completed once", async () => {
    trackSignup("passkey");
    trackSignup("passkey");
    await flush();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]![0]).toBe("signup_completed");
  });

  it("emits session_started once per session", async () => {
    trackSessionStarted();
    trackSessionStarted();
    await flush();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]![0]).toBe("session_started");
  });
});

describe("core actions repeat, by design", () => {
  it("emits every time — the loop is the metric", async () => {
    trackCoreAction("order_placed", { market: "MON", side: "long" });
    trackCoreAction("order_placed", { market: "MON", side: "short" });
    await flush();
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls[0]![1]).toMatchObject({
      action_type: "order_placed",
      market: "MON",
      side: "long",
    });
  });
});

describe("every event carries the redacted route", () => {
  it("attaches the route, and it is the shape not the URL", async () => {
    trackFeature("autonomy_granted", { mode: "full" });
    await flush();
    const props = capture.mock.calls[0]![1] as Record<string, unknown>;
    expect(props.route).toBe("/hunt/:id");
    expect(props.feature_name).toBe("autonomy_granted");
    // Nothing resembling a real identifier reached the payload.
    const blob = JSON.stringify(props);
    expect(blob).not.toMatch(/0x[a-fA-F0-9]{10,}/);
    expect(blob).not.toMatch(/\?|token=/);
  });
});
