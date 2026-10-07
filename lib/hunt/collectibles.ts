/**
 * NFTs a hunter holds on Monad.
 *
 * WHY A LIST AND NOT A LOOKUP. "Everything this address owns" is a question an
 * RPC cannot answer — there is no index from owner to token. Answering it
 * properly needs an indexer, which this project does not have since Envio was
 * removed. So collections are named here and each is checked directly. That is
 * honest about what it shows: these collections, not "your NFTs".
 *
 * The enumeration is by Transfer LOG rather than `tokenOfOwnerByIndex`, because
 * r3tards — the first collection anyone actually received — does not implement
 * ERC721Enumerable: `supportsInterface(0x780e9d63)` is false and the call
 * reverts. Logs work for every ERC-721 regardless.
 *
 * Every candidate is then confirmed with `ownerOf`, because a Transfer IN says
 * nothing about whether it is still there.
 */

export interface Collection {
  address: `0x${string}`;
  name: string;
  /** Block to start scanning from. Collections are young; genesis is waste. */
  fromBlock: bigint;
}

export interface Collectible {
  collection: string;
  contract: string;
  tokenId: string;
  name: string | null;
  image: string | null;
}

/**
 * Known Monad collections, newest first.
 *
 * r3tards was verified on mainnet 2026-10-06: a hunter claimed #936 at Monad
 * Open on a kiosk, sent it to the wallet her passkey made, and had nowhere in
 * the app to see it.
 */
/**
 * How far back a collection discovered at runtime is scanned.
 *
 * Monad mainnet opened 2025-11-24 and editions are far younger, so this is
 * generous. It is a REAL limit, not a formality: a token transferred before
 * this block will not be listed. rpc1 serves ranges this wide in one call —
 * the app's own transport cannot, which is why the route does not use it.
 */
export const DEFAULT_FROM_BLOCK = 90_000_000n;

export const COLLECTIONS: readonly Collection[] = [
  {
    address: "0x200723a706de0013316e5cd8eba2b3f53dd90c29",
    name: "r3tards",
    fromBlock: 110_000_000n,
  },
  // EmpowerTours' own. Not reachable through EditionClaim, because a passport
  // is minted rather than claimed, so it has to be named here or it is
  // invisible in the wallet it belongs to.
  {
    address: "0x4d5533e29cf190131885dc7dbef22e31f4252410",
    name: "EmpowerTours Passport",
    fromBlock: 90_000_000n,
  },
] as const;

/** `Transfer(address,address,uint256)` */
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** An address as a 32-byte topic. */
export function addressTopic(address: string): `0x${string}` {
  const bare = address.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(bare)) {
    throw new RangeError(`not an address: ${address}`);
  }
  return `0x${bare.padStart(64, "0")}`;
}

/**
 * Token ids out of a batch of Transfer logs, de-duplicated and in order.
 *
 * A token can arrive, leave and arrive again, which is three logs and one
 * token. `ownerOf` decides the truth afterwards; this only has to produce
 * candidates without repeating them.
 */
export function tokenIdsFromLogs(
  logs: readonly { topics: readonly string[] }[],
): bigint[] {
  const seen = new Set<string>();
  const out: bigint[] = [];
  for (const log of logs) {
    // A 3-topic Transfer is ERC-20: same signature, no indexed tokenId. It
    // must not be read as token 0.
    if (log.topics.length !== 4) continue;
    const raw = log.topics[3];
    if (typeof raw !== "string") continue;
    let id: bigint;
    try {
      id = BigInt(raw);
    } catch {
      continue;
    }
    const key = id.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

/**
 * The gateway `ipfs://` is rewritten through.
 *
 * NOT ipfs.io. As of 2026-10-06 it no longer serves content at all — a request
 * returns the string "This IPFS gateway is switching to a service worker
 * gateway only" with a 200, so the fetch SUCCEEDS and the JSON parse fails, and
 * every edition rendered as an untitled black square. The project's own Pinata
 * gateway returns the metadata in about a second, and `lib/editions/thumb.ts`
 * can already ask it to resize.
 */
export const IPFS_GATEWAY =
  process.env.IPFS_GATEWAY?.replace(/\/+$/, "") ??
  "https://harlequin-used-hare-224.mypinata.cloud/ipfs";

/**
 * A tokenURI or image field turned into something a browser will load.
 *
 * MetaMask will not resolve `ipfs://` on Monad, and neither will an <img>, so
 * anything ipfs has to go through a gateway or it renders blank. r3tards
 * happens to serve https already; the editions do not.
 */
export function toHttpUrl(uri: string | null | undefined): string | null {
  if (!uri) return null;
  const trimmed = uri.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("ipfs://")) {
    const path = trimmed.slice("ipfs://".length).replace(/^ipfs\//, "");
    return `${IPFS_GATEWAY}/${path}`;
  }
  if (trimmed.startsWith("ar://")) {
    return `https://arweave.net/${trimmed.slice("ar://".length)}`;
  }
  if (/^https?:\/\//.test(trimmed)) return trimmed;
  if (trimmed.startsWith("data:")) return trimmed;
  // Anything else — a bare CID, a relative path — is not something to guess at.
  return null;
}

/** Pull name and image out of token metadata without trusting its shape. */
export function readMetadata(raw: unknown): {
  name: string | null;
  image: string | null;
} {
  if (typeof raw !== "object" || raw === null) {
    return { name: null, image: null };
  }
  const o = raw as Record<string, unknown>;
  const name =
    typeof o.name === "string" && o.name.trim() !== "" ? o.name : null;
  const image =
    typeof o.image === "string"
      ? o.image
      : typeof o.image_url === "string"
        ? o.image_url
        : null;
  return { name, image: toHttpUrl(image) };
}

/**
 * Every collection worth scanning for one hunter: the named ones, plus the
 * collections they personally claimed an edition from.
 *
 * Editions are NOT one contract. `EditionClaim.collection` is per row, because
 * each work belongs to its artist's own collection, so there is no single
 * address to add to the list above. Deriving it from the hunter's own claims
 * also means nobody is scanned against collections they never touched.
 */
export function collectionsForPlayer(
  claimed: readonly { collection: string }[],
  base: readonly Collection[] = COLLECTIONS,
): Collection[] {
  const out: Collection[] = [];
  const seen = new Set<string>();
  for (const c of base) {
    const key = c.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  for (const row of claimed) {
    const raw = row.collection?.trim().toLowerCase();
    // A malformed row must not become an eth_getLogs for address "undefined".
    if (!raw || !/^0x[0-9a-f]{40}$/.test(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push({
      address: raw as `0x${string}`,
      name: "Editions",
      fromBlock: DEFAULT_FROM_BLOCK,
    });
  }
  return out;
}
