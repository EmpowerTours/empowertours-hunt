// Live treasury balance, read from Monad.
//
// Server-only. The private key is used solely to derive the public address —
// it is never returned, never logged, and never reaches a response body. If a
// deployment prefers not to expose the key to this process at all, set
// `HUNT_TREASURY_ADDRESS` and the key is not touched here.
//
// A failure to reach the RPC returns `null` rather than throwing: the operator
// still needs to see what is owed even when the balance is unavailable, and a
// blank number next to a big liability is a clearer signal than a 500 page.

import { createPublicClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad } from "@/lib/monad";

export interface TreasuryBalance {
  address: string | null;
  balanceWei: bigint | null;
  error: string | null;
}

function treasuryAddress(): string | null {
  const explicit = process.env.HUNT_TREASURY_ADDRESS;
  if (explicit && /^0x[0-9a-fA-F]{40}$/.test(explicit)) {
    return explicit.toLowerCase();
  }
  const pk = process.env.HUNT_TREASURY_PRIVATE_KEY;
  if (!pk) return null;
  try {
    return privateKeyToAccount(pk as Hex).address.toLowerCase();
  } catch {
    // Deliberately does not echo the key, or any prefix of it, into the log.
    console.error("[admin-treasury] HUNT_TREASURY_PRIVATE_KEY is malformed");
    return null;
  }
}

export async function readTreasuryBalance(): Promise<TreasuryBalance> {
  const address = treasuryAddress();
  if (!address) {
    return {
      address: null,
      balanceWei: null,
      error: "treasury address not configured",
    };
  }

  try {
    const client = createPublicClient({
      chain: monad,
      // Honour the override; viem falls back to the chain default when unset.
      transport: http(process.env.MONAD_RPC_URL),
    });
    const balanceWei = await client.getBalance({ address: address as Hex });
    return { address, balanceWei, error: null };
  } catch (e) {
    return {
      address,
      balanceWei: null,
      error: e instanceof Error ? e.message : "RPC unavailable",
    };
  }
}
