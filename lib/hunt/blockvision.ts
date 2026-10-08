/**
 * NFTs from BlockVision's Monad indexing API.
 *
 * WHY THIS EXISTS. "What does this address own?" is not a question an RPC can
 * answer — there is no owner index, which is why the first version of the
 * wallet panel scanned Transfer logs against a HARDCODED list of two
 * collections. Anything a hunter was sent from outside that list was
 * invisible, and so was anything moved before DEFAULT_FROM_BLOCK.
 *
 * Verified against mainnet 2026-10-08: the hunter who claimed r3tards #936 at
 * a Monad Open kiosk comes back correctly, without the collection being named
 * anywhere.
 *
 * The log scan stays as the fallback. This is a hackathon perk with an expiry,
 * and a wallet that empties itself when a key lapses is worse than one that
 * shows two collections.
 */

import type { Collectible } from "./collectibles";

export const BLOCKVISION_BASE = "https://api.blockvision.org/v2/monad";

/** One collection in the response, with its tokens nested inside. */
interface RawItem {
  name?: unknown;
  tokenId?: unknown;
  image?: unknown;
  contractAddress?: unknown;
}
interface RawCollection {
  contractAddress?: unknown;
  name?: unknown;
  image?: unknown;
  verified?: unknown;
  scamFlag?: unknown;
  ercStandard?: unknown;
  items?: unknown;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

/**
 * Collections -> a flat list of what the wallet shows.
 *
 * SCAM FLAGGED COLLECTIONS ARE DROPPED. Anyone can airdrop an NFT to any
 * address, and a convincing fake in a wallet that also holds real money is a
 * phishing surface we would be rendering ourselves. BlockVision marks them;
 * ignoring that would be choosing not to know.
 *
 * Tolerant of shape: this is somebody else's API and a missing field must
 * cost one token, not the whole panel.
 */
export function parseBlockVisionNfts(payload: unknown): Collectible[] {
  if (typeof payload !== "object" || payload === null) return [];
  const result = (payload as { result?: unknown }).result;
  if (typeof result !== "object" || result === null) return [];
  const data = (result as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const out: Collectible[] = [];
  for (const raw of data) {
    if (typeof raw !== "object" || raw === null) continue;
    const c = raw as RawCollection;

    // Flagged as a scam by the indexer. Not shown, not counted.
    if (typeof c.scamFlag === "number" && c.scamFlag > 0) continue;

    const collectionName = str(c.name) ?? "Unknown collection";
    const collectionImage = str(c.image);
    const items = Array.isArray(c.items) ? c.items : [];

    for (const rawItem of items) {
      if (typeof rawItem !== "object" || rawItem === null) continue;
      const i = rawItem as RawItem;
      const tokenId = str(i.tokenId);
      // Without a token id there is nothing stable to key the row on, and two
      // tokens from one collection would collide in the list.
      if (tokenId === null) continue;
      const contract = str(i.contractAddress) ?? str(c.contractAddress);
      if (contract === null) continue;

      out.push({
        collection: collectionName,
        contract,
        tokenId,
        name: str(i.name),
        // The collection's artwork is the fallback, so a token whose own
        // image failed to index still shows something rather than a void.
        image: str(i.image) ?? collectionImage,
      });
    }
  }
  return out;
}
