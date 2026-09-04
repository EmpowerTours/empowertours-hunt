import { createPublicClient, http, parseAbi, type Address } from "viem";
import { monad } from "@/lib/monad";

// ---------------------------------------------------------------------------
// Reading the TurboCohort price.
//
// The price a redemption is charged at is on-chain state, not a constant here.
// Hardcoding it would keep selling months at whatever the price was the day
// somebody typed it in — silently, and in the player's favour or against them
// depending on which way the cohort moved it.
//
// READ ONLY. This module holds no key and calls no state-changing function.
// It cannot: the deployed TurboCohort exposes `payMonthly(uint8)`, which pays
// for `msg.sender`, so there is no pay-on-behalf entry point for a treasury to
// call even if one wanted to. That fact is why settlement is a person's job —
// see prisma `model Redemption`.
// ---------------------------------------------------------------------------

const COHORT_ABI = parseAbi([
  "function tierPrice(uint8 tier) view returns (uint256)",
]);

/**
 * Tier ids as the cohort contract numbers them.
 *
 * ONE-BASED, with 0 meaning None. This was written 0-based and every value was
 * wrong by one: Explorer read tier 0, which prices at 0 WMON, and Builder and
 * Founder each read the tier below their own — so a redemption would have been
 * charged Explorer's price for Builder's month.
 *
 * Explorer never became "free months" only because readTierPriceWei refuses a
 * non-positive price. That guard was written for a failed RPC read and caught
 * an indexing mistake instead, which is the argument for having it.
 *
 * Verified on chain 2026-09-04 against 0xEae0…1Ab5:
 *   tier 1 = 139 WMON, tier 2 = 556 WMON.
 */
export const TIERS = { EXPLORER: 1, BUILDER: 2, FOUNDER: 3 } as const;
export type TierName = keyof typeof TIERS;

export function isTierName(v: string): v is TierName {
  return Object.prototype.hasOwnProperty.call(TIERS, v);
}

function cohortAddress(): Address | null {
  const raw = process.env.NEXT_PUBLIC_TURBO_COHORT_ADDRESS;
  if (raw === undefined || !/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
  return raw as Address;
}

/**
 * Current price of one month, in WMON-wei.
 *
 * Returns null rather than a fallback when the address is unset or the read
 * fails. A fallback price would be a guess at what somebody owes, and
 * `planRedemption` refuses a zero price precisely so a bad RPC day cannot mint
 * free subscriptions.
 */
export async function readTierPriceWei(tier: TierName): Promise<bigint | null> {
  const address = cohortAddress();
  if (address === null) return null;

  try {
    const client = createPublicClient({
      chain: monad,
      transport: http(process.env.MONAD_RPC_URL),
    });
    const price = await client.readContract({
      address,
      abi: COHORT_ABI,
      functionName: "tierPrice",
      args: [TIERS[tier]],
    });
    return price > 0n ? price : null;
  } catch {
    return null;
  }
}
