// What fcempowertours currently has for sale, in the shape placement needs.
//
// ## Why the endpoint and not the chain
//
// Both were measured on 2026-09-20 against the live system:
//
//   music.empowertours.xyz/api/catalogue   0.39s   one request   4.3 KB
//   totalMasters + 12 x masterTokens       7.90s   13 requests
//
// Speed is the least of it. The endpoint ALREADY READS THE CONTRACTS — it
// answers `source: "chain"`, `reason: "read from the contracts"` — so this is
// not trading freshness for convenience. What it adds is the two things a card
// needs and the chain does not give: resolved `name` and `imageUrl` (on chain
// there is only an ipfs:// tokenURI, which would mean a per-master IPFS fetch
// before anything could be drawn), and the `active` filter — 12 masters exist,
// 6 are active, and the endpoint returns exactly those 6.
//
// ## BOTH tiers, and why the old reason for STANDARD-only no longer holds
//
// This placed the standard licence and never the collector edition, because
// collector prices are set deliberately and some are enormous on purpose —
// Killah's is 1,000,000 WMON — so placing one would put a card on the scope
// that no hunter could ever act on.
//
// That reasoning was right when it was written and is now redundant.
// `placeableFor` filters the catalogue by what the hunter can actually pay
// BEFORE the draw, so a 1,000,000 WMON card is already unreachable for
// everyone who cannot afford it, and reachable for anyone who can. Excluding
// the tier outright did not protect a hunter from an impossible card; it
// denied a funded one the only card they might have wanted.
//
// So the guard that matters is affordability, which exists, plus supply:
// `purchase` reverts once maxCollectorEditions is reached, so a sold-out tier
// must never be offered. That is what `collectorsRemaining` is for, and it is
// why the price alone is not enough to decide.
//
// ## Unavailable is not empty
//
// A failed read must never reach a player as "there is nothing here". Those
// are different facts with different remedies, they are different deny reasons
// in lib/hunt/edition.ts, and a failure is never cached.

import type { EditionOffer } from "@/lib/hunt/edition";

/** An offer plus what the card has to draw. */
export interface CatalogueEntry extends EditionOffer {
  name: string;
  imageUrl: string | null;
  /** ~3s clip. Load on tap, never on sight: it is an uncompressed WAV. */
  previewUrl: string | null;
}

export type CatalogueResult =
  | { ok: true; entries: CatalogueEntry[]; fetchedAt: number }
  | { ok: false; reason: "catalogue_unavailable" };

/** Shape of one track as the venue returns it. Unknown fields are ignored. */
interface VenueTrack {
  tokenId?: unknown;
  price?: unknown;
  isArt?: unknown;
  name?: unknown;
  imageUrl?: unknown;
  previewUrl?: unknown;
  /**
   * The collector tier. Absent on a venue that has not deployed the field yet,
   * which is exactly how this rolls out safely: no collectorPrice means no
   * collector entry, and the catalogue behaves as it always did.
   */
  collectorPrice?: unknown;
  collectorsRemaining?: unknown;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Map one venue track, or null if it cannot be trusted.
 *
 * Reject by default: a track without a usable id or a positive price is
 * skipped rather than defaulted. A zero price here would become a PURCHASE
 * offer the venue then refuses (SalesController reverts ZeroPrice), so the
 * hunter would walk to a card that cannot complete.
 */
export function toEntry(
  track: VenueTrack,
  collection: string,
): CatalogueEntry | null {
  const masterId = asString(track.tokenId);
  const rawPrice = asString(track.price);
  if (masterId === null || rawPrice === null) return null;

  let priceWei: bigint;
  try {
    priceWei = BigInt(rawPrice);
  } catch {
    return null;
  }
  if (!(priceWei > 0n)) return null;

  return {
    collection,
    masterId,
    kind: track.isArt === true ? "ART" : "MUSIC",
    tier: "STANDARD",
    // Everything the venue lists is for sale. FREE is an app decision — a
    // giveaway the relayer funds — never a property of the catalogue.
    terms: "PURCHASE",
    priceWei,
    name: asString(track.name) ?? `#${masterId}`,
    imageUrl: asString(track.imageUrl),
    previewUrl: asString(track.previewUrl),
  };
}

/**
 * The same work's COLLECTOR offer, or null when there is not one to make.
 *
 * Separate from `toEntry` rather than folded into it because the two tiers fail
 * for different reasons and a caller must be able to get one without the other:
 * a master can have a perfectly good standard licence and a sold-out collector
 * tier, and the standard one should still be placed.
 *
 * Reject by default. Four ways to have no collector offer, all of them normal:
 *   - the venue does not send the field at all (older deployment)
 *   - the master has no collector tier, which prices at zero
 *   - the tier is sold out
 *   - the price is unparseable
 *
 * Supply is checked HERE and not left to the purchase, because `purchase`
 * reverts once maxCollectorEditions is reached and Monad charges the whole gas
 * limit on a revert. An offered card that cannot complete costs the hunter
 * real MON to discover.
 */
export function collectorEntry(
  track: VenueTrack,
  collection: string,
): CatalogueEntry | null {
  const standard = toEntry(track, collection);
  // Reuse the standard mapping for everything the two tiers share — id, name,
  // artwork, kind. If the work is not offerable at all, neither tier is.
  if (standard === null) return null;

  const raw = asString(track.collectorPrice);
  if (raw === null) return null;
  let priceWei: bigint;
  try {
    priceWei = BigInt(raw);
  } catch {
    return null;
  }
  // Zero means "no collector tier for this master", not "free" — the venue
  // reverts on a zero price, so this is unbuyable either way.
  if (!(priceWei > 0n)) return null;

  // Anything that is not a positive number counts as sold out. A missing field
  // from an older venue lands here, which is the safe direction.
  const remaining =
    typeof track.collectorsRemaining === "number" ? track.collectorsRemaining : 0;
  if (!(remaining > 0)) return null;

  return { ...standard, tier: "COLLECTOR", priceWei };
}

/** Parse a whole response body. Exported so it can be tested without a network. */
export function parseCatalogue(
  body: unknown,
  collection: string,
): CatalogueEntry[] | null {
  if (typeof body !== "object" || body === null) return null;
  const tracks = (body as { tracks?: unknown }).tracks;
  if (!Array.isArray(tracks)) return null;
  // One track can yield two offers. The draw is uniform over OFFERS, not over
  // works, so a master with both tiers is twice as likely to come up as one
  // with only a standard licence — which is correct: there are two distinct
  // things to be found, at two prices, and a hunter may hold one of each.
  return tracks.flatMap((t) => {
    const track = t as VenueTrack;
    const out: CatalogueEntry[] = [];
    const standard = toEntry(track, collection);
    if (standard !== null) out.push(standard);
    const collector = collectorEntry(track, collection);
    if (collector !== null) out.push(collector);
    return out;
  });
}

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 6_000;

let cached: { entries: CatalogueEntry[]; fetchedAt: number } | null = null;
let inFlight: Promise<CatalogueResult> | null = null;

/** Drop the cache. Tests only. */
export function resetCatalogueCache(): void {
  cached = null;
  inFlight = null;
}

/**
 * The catalogue, cached, with one request in flight at a time.
 *
 * Single-flight matters because placement runs per player: without it a busy
 * hunt would put one request per scan onto somebody else's service. The cache
 * holds only successes — a failure is never stored, so the next caller retries
 * rather than inheriting a negative for five minutes.
 */
export async function readCatalogue(opts?: {
  url?: string;
  collection?: string;
  ttlMs?: number;
  now?: number;
}): Promise<CatalogueResult> {
  const url = opts?.url ?? process.env.EDITION_CATALOGUE_URL;
  const collection = opts?.collection ?? process.env.EDITION_LICENSE_REGISTRY;
  const ttl = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts?.now ?? Date.now();

  // Unconfigured is unavailable, not empty. A deployment without editions set
  // up offers nothing and says so, rather than reporting an empty catalogue.
  if (!url || !collection)
    return { ok: false, reason: "catalogue_unavailable" };

  if (cached && now - cached.fetchedAt < ttl) {
    return { ok: true, entries: cached.entries, fetchedAt: cached.fetchedAt };
  }
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<CatalogueResult> => {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        headers: { accept: "application/json" },
      });
      if (!res.ok) return { ok: false, reason: "catalogue_unavailable" };
      const entries = parseCatalogue(await res.json(), collection);
      if (entries === null)
        return { ok: false, reason: "catalogue_unavailable" };
      // A genuinely empty catalogue IS cached: "the venue has nothing active"
      // is an answer, and re-asking every scan would not change it.
      cached = { entries, fetchedAt: now };
      return { ok: true, entries, fetchedAt: now };
    } catch {
      // Timeout, DNS, malformed JSON. Never cached.
      return { ok: false, reason: "catalogue_unavailable" };
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
