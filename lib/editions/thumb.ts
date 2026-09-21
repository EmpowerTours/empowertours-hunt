// A cover sized for the box it is drawn in.
//
// Master 13's artwork is 1024x1024 and 197KB, and /dime renders it into a
// 160 CSS-pixel frame — roughly 40x the pixels needed, on a landing page for
// cold traffic off a social post where the first second decides whether they
// stay.
//
// Pinata's dedicated gateway resizes on demand, so no derivative has to be
// generated, stored or kept in sync with a campaign. Measured against the live
// gateway 2026-09-21, three samples each:
//
//   original      197,232 B   1.17s
//   img-width=320  15,420 B   0.24s     <- 2x display of a 160px box
//   img-width=480  31,756 B   0.22s     <- 3x display
//   img-width=640  51,696 B   0.24s
//
// ## No WebP, deliberately
//
// `img-format=webp` was measured too and is NOT reliably smaller: at 320 it
// came back 16,104 B against JPEG's 15,420. Forcing a format would pin us to
// the worse one at the size we actually serve, so the gateway is left to
// choose. Timings are round-trip dominated at every one of these sizes — the
// win here is BYTES on a phone plan, not latency.
//
// ## Only Pinata, checked rather than assumed
//
// `imageUrl` comes from whatever gateway the venue resolved, and a master
// pinned elsewhere would get a query string its host does not understand.
// Most would ignore it; a signed or presigned URL would break outright. So the
// host is matched first and anything unrecognised is returned untouched — the
// full-size image is a slow cover, a broken one is no cover.

/** Hosts known to resize on demand via `img-width`. */
function resizes(host: string): boolean {
  return host === "mypinata.cloud" || host.endsWith(".mypinata.cloud");
}

/**
 * The same image, asked for at `width` pixels, when the gateway can do it.
 *
 * Returns the input unchanged for any host that cannot, for a malformed URL,
 * and for null — this sits in a render path, so it must never throw.
 */
export function thumbUrl(url: string | null, width: number): string | null {
  if (url === null || url === "") return url;
  if (!Number.isInteger(width) || width <= 0) return url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (!resizes(u.hostname)) return url;
  // searchParams.set rather than string concatenation: the URL may already
  // carry a query, and "?a=1?img-width=320" is not a query string.
  u.searchParams.set("img-width", String(width));
  return u.toString();
}

/**
 * `srcSet` for a box `cssPx` wide, or null when the gateway cannot resize.
 *
 * Width descriptors plus a `sizes` of the box let the browser pick by device
 * pixel ratio: a 2x phone takes the 320, a 3x phone the 480. Null tells the
 * caller to fall back to a plain `src` rather than emitting a srcSet of one
 * unresized image, which would just be the 197KB original twice.
 */
export function thumbSrcSet(url: string | null, cssPx: number): string | null {
  if (url === null || url === "") return null;
  const two = thumbUrl(url, cssPx * 2);
  const three = thumbUrl(url, cssPx * 3);
  if (two === url || three === url) return null; // host cannot resize
  return `${two} ${cssPx * 2}w, ${three} ${cssPx * 3}w`;
}
