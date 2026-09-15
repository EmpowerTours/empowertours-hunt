import { describe, expect, it } from "vitest";
import { postOnlyResponse } from "./post-only";

describe("postOnlyResponse — the 405 a browser can actually read", () => {
  const res = () =>
    postOnlyResponse("/api/cota/reconcile", "use the button on /cota/trade.");

  it("is a 405", () => {
    expect(res().status).toBe(405);
  });

  it("CARRIES A CONTENT-TYPE — this is the whole bug", () => {
    // Next.js answers an unhandled method with an empty, untyped 405, and with
    // nosniff set the browser may render nothing and download the response
    // instead. A hunter who typed the URL got a file and no explanation.
    expect(res().headers.get("content-type")).toMatch(/application\/json/);
  });

  it("has a non-empty body saying where the action is taken", async () => {
    const body = await res().json();
    expect(body.error).toBe("method_not_allowed");
    expect(body.detail).toContain("/api/cota/reconcile");
    expect(body.detail).toContain("/cota/trade");
    expect(body.detail.length).toBeGreaterThan(20);
  });

  it("sends the Allow header a 405 is supposed to carry", () => {
    expect(res().headers.get("allow")).toBe("POST");
  });

  it("names POST as the only method", async () => {
    expect((await res().json()).allow).toEqual(["POST"]);
  });
});
