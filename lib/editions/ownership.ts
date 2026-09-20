// Does this hunter hold a licence we did not sell them?
//
// ## Why this is a warning and never a gate
//
// The registry's cheap read is `licensesHeld(owner, masterTokenId) -> uint32`,
// a straight mapping lookup. It counts licences for a master REGARDLESS OF
// TIER, and that is the whole difficulty: standard and collector are separate
// products with separate prices and a separate cap, so excluding on this read
// would bar somebody from the 35 WMON standard because they own the 500 WMON
// collector. That is the conversion the tier key in EditionClaim exists to
// protect, broken from the other side.
//
// Enumerating their licence tokens and reading `License.isCollector` on each
// would be exact, but it grows with how much they own and runs on a poll.
//
// ## What makes a coarse read usable anyway
//
// We already know, exactly, the tier of everything WE sold — that is what
// EditionClaim is. So the question worth asking is not "do they hold a
// licence" but "do they hold one we cannot account for":
//
//     unexplained = licensesHeld(master) - our claims for that master
//
// Bought the standard through hunt: 1 - 1 = 0, no warning when the collector
// is later offered. Bought it at the venue: 1 - 0 = 1, warned, and honestly
// so, because that licence really is unaccounted for and we cannot tell which
// tier it is.
//
// FAILS OPEN. An RPC error yields null and no warning is shown. A missing
// warning costs somebody a duplicate they chose to risk; a blocked purchase
// costs a sale and confuses a hunter who owns nothing. The real gate is the
// unique index on EditionClaim, which is free and authoritative for anything
// we sold.

import { createPublicClient, http, parseAbi, type Address } from "viem";
import { monad, monadRpcUrl } from "@/lib/monad";

const REGISTRY_ABI = parseAbi([
  "function licensesHeld(address owner, uint256 masterTokenId) view returns (uint32)",
]);

/**
 * Licences held for `masterId` that our own records do not explain.
 *
 * Returns null when the chain could not be asked — distinct from 0, which
 * means "asked, and there are none". The caller must treat null as "show
 * nothing", never as "none".
 */
export async function unexplainedLicences(args: {
  registry: Address;
  owner: Address;
  masterId: bigint;
  /** How many licences for this master our EditionClaim rows account for. */
  knownCount: number;
}): Promise<number | null> {
  try {
    const client = createPublicClient({
      chain: monad,
      transport: http(monadRpcUrl()),
    });
    const held = await client.readContract({
      address: args.registry,
      abi: REGISTRY_ABI,
      functionName: "licensesHeld",
      args: [args.owner, args.masterId],
    });
    // Clamped at zero. Our count can legitimately exceed the chain's — a
    // PENDING claim is recorded before the licence exists, and a hunter may
    // have transferred one away — and a negative would render as a warning
    // about owing licences, which is nonsense.
    return Math.max(0, Number(held) - args.knownCount);
  } catch {
    return null;
  }
}
