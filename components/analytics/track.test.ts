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

describe("activation fires once per browser", () => {
  it("emits the first time and never again", async () => {
    trackActivation("leash_signed");
    trackActivation("leash_signed");
    trackActivation("leash_signed");
    await flush();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]![0]).toBe("activation");
    expect(capture.mock.calls[0]![1]).toMatchObject({
      jtbd_name: "leash_signed",
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
