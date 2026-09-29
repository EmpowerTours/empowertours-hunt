// Turning a URL into something safe to send to a third party.
//
// WHY THIS IS A SEPARATE, TESTED FUNCTION. Analytics wants to know which
// screens get used. It has no business knowing WHICH hunt, WHICH player or
// WHICH leash, and this app puts all three in the path. Worse, some URLs in
// this product carry single-use tokens in the query string — a homework submit
// token, a gift link — and shipping one to a vendor's servers would both leak
// it and log it somewhere we do not control.
//
// So nothing sends `window.location`. Everything sends the output of this
// function, which keeps the SHAPE of the route and throws away the identity:
//
//     /hunt/cmtlo4koj0000n81yt6zjt91d   ->  /hunt/:id
//     /cota/trade?token=abc            ->  /cota/trade
//
// It fails toward redacting. A segment that might be an identifier becomes
// `:id` even if that occasionally flattens a real route name, because the cost
// of over-redacting is a slightly coarser funnel and the cost of
// under-redacting is somebody's identifier in a vendor's database.

/** Path segments that are real route names, never identifiers. */
const KNOWN = new Set([
  "hunt",
  "cota",
  "trade",
  "risk",
  "history",
  "enroll",
  "deposit",
  "swap",
  "usdc",
  "spot",
  "bridge",
  "onramp",
  "practice",
  "wallet",
  "judge",
  "record",
  "admin",
  "diag",
  "download",
  "dime",
  "api",
  "editions",
  "career",
  "manifest",
]);

/**
 * True when a path segment looks like it identifies somebody or something.
 *
 * Deliberately broad. cuid2 (`cmtlo4koj0000n81yt6zjt91d`), uuids, hex
 * addresses, numeric ids and anything long and mixed-case all count.
 */
export function looksLikeId(segment: string): boolean {
  if (segment.length === 0) return false;
  if (KNOWN.has(segment.toLowerCase())) return false;
  if (/^0x[a-fA-F0-9]{6,}$/.test(segment)) return true;
  if (/^\d+$/.test(segment)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(segment)) return true;
  // Long opaque strings: cuids, nanoids, tokens. 12 is comfortably longer than
  // every route name this app uses and comfortably shorter than every id it
  // generates.
  if (segment.length >= 12 && /^[A-Za-z0-9_-]+$/.test(segment)) return true;
  return false;
}

/**
 * The route shape for a pathname, with every identifier replaced and any query
 * string or fragment discarded.
 *
 * Takes a pathname, not a URL. Passing a full URL still works — the origin is
 * stripped — but the caller should never have had the query string in hand.
 */
export function routeName(pathnameOrUrl: string): string {
  let path = pathnameOrUrl;
  // Drop scheme+host if a whole URL was handed in, then query and fragment.
  path = path.replace(/^[a-z]+:\/\/[^/]+/i, "");
  path = path.split("?")[0]!.split("#")[0]!;
  if (path === "" || path === "/") return "/";

  const out = path
    .split("/")
    .map((seg) => (looksLikeId(seg) ? ":id" : seg))
    .join("/");
  // Trailing slash carries no information and would split one route in two.
  return out.length > 1 && out.endsWith("/") ? out.slice(0, -1) : out;
}
