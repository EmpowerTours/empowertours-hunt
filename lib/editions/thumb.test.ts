// The cover must get smaller, and must never get broken.
//
// This sits in a render path on a page built for cold traffic, so the failure
// that matters is not "the image is large" — it is "the image does not load at
// all" because a query string was bolted onto a host that could not take one.

import { describe, expect, it } from "vitest";
import { thumbSrcSet, thumbUrl } from "./thumb";

const PINATA =
  "https://harlequin-used-hare-224.mypinata.cloud/ipfs/QmXTkB2UHozwVsfy3RReDMD6HcfEYypKZhS6RGZsJGd52K";

describe("thumbUrl", () => {
  it("asks a Pinata gateway for the width we actually draw", () => {
    expect(thumbUrl(PINATA, 320)).toBe(`${PINATA}?img-width=320`);
  });

  it("leaves a gateway that cannot resize completely alone", () => {
    // Appending a query it does not understand is at best useless and at worst
    // breaks a signed URL. A slow cover beats a broken one.
    const other = "https://ipfs.io/ipfs/QmXTkB2UHozwVsfy3RReDMD6HcfEYypKZhS6";
    expect(thumbUrl(other, 320)).toBe(other);
  });

  it("does not match a lookalike host", () => {
    // mypinata.cloud.evil.example must not be treated as Pinata.
    const spoof = "https://mypinata.cloud.evil.example/ipfs/Qm123";
    expect(thumbUrl(spoof, 320)).toBe(spoof);
  });

  it("merges into an existing query instead of making a second one", () => {
    // "?a=1?img-width=320" is not a query string.
    const withQuery = `${PINATA}?filename=cover.jpg`;
    const out = thumbUrl(withQuery, 320)!;
    expect(out).toContain("filename=cover.jpg");
    expect(out).toContain("img-width=320");
    expect(out.split("?").length).toBe(2);
  });

  it("replaces a width already present rather than appending a second", () => {
    const once = thumbUrl(PINATA, 320)!;
    const twice = thumbUrl(once, 480)!;
    expect(twice).toBe(`${PINATA}?img-width=480`);
  });

  it("never throws on the inputs a render path actually sees", () => {
    expect(thumbUrl(null, 320)).toBeNull();
    expect(thumbUrl("", 320)).toBe("");
    expect(thumbUrl("not a url", 320)).toBe("not a url");
    expect(thumbUrl(PINATA, 0)).toBe(PINATA);
    expect(thumbUrl(PINATA, -1)).toBe(PINATA);
    expect(thumbUrl(PINATA, 1.5)).toBe(PINATA);
  });
});

describe("thumbSrcSet", () => {
  it("offers 2x and 3x for the box, by width descriptor", () => {
    // A 160px box: a 2x phone wants 320, a 3x phone wants 480.
    expect(thumbSrcSet(PINATA, 160)).toBe(
      `${PINATA}?img-width=320 320w, ${PINATA}?img-width=480 480w`,
    );
  });

  it("returns null when the host cannot resize", () => {
    // Otherwise the srcSet would be the same 197KB original listed twice,
    // which tells the browser a lie about what it is choosing between.
    expect(thumbSrcSet("https://ipfs.io/ipfs/Qm1", 160)).toBeNull();
    expect(thumbSrcSet(null, 160)).toBeNull();
  });
});
