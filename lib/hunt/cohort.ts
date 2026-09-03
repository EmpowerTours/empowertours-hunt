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

/** Tier ids as the cohort contract numbers them. */
export const TIERS = { EXPLORER: 0, BUILDER: 1, FOUNDER: 2 } as const;
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
