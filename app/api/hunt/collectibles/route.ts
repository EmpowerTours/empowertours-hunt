import { NextResponse } from "next/server";
import { createPublicClient, http, parseAbi } from "viem";
import { requirePlayer, AuthError } from "@/lib/auth";
import { monad } from "@/lib/monad";
import {
  COLLECTIONS,
  TRANSFER_TOPIC,
  addressTopic,
  readMetadata,
  toHttpUrl,
  tokenIdsFromLogs,
  type Collectible,
} from "@/lib/hunt/collectibles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ERC721 = parseAbi([
  "function ownerOf(uint256) view returns (address)",
  "function tokenURI(uint256) view returns (string)",
]);

/**
 * Deliberately NOT monadTransport().
 *
 * This is the one read in the app that needs a WIDE eth_getLogs range. The
 * configured endpoint caps at 100 blocks and rpc2 at roughly 25k, so scanning a
 * collection's lifetime through either would take hundreds of round trips.
 * rpc1 serves a million blocks in one call. It refuses debug_traceTransaction,
 * which is exactly why it is not the app's general transport — and nothing here
 * traces. Measured 2026-10-06.
 */
const LOG_RPC = "https://rpc1.monad.xyz";

export async function GET(req: Request) {
  let wallet: string;
  try {
    wallet = (await requirePlayer(req)).walletAddress;
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    throw e;
  }

  const client = createPublicClient({ chain: monad, transport: http(LOG_RPC) });
  const owner = addressTopic(wallet);
  const items: Collectible[] = [];

  for (const collection of COLLECTIONS) {
    let candidates: bigint[];
    try {
      const logs = (await client.request({
        method: "eth_getLogs",
        params: [
          {
            address: collection.address,
            fromBlock: `0x${collection.fromBlock.toString(16)}`,
            toBlock: "latest",
            topics: [TRANSFER_TOPIC, null, owner],
          },
        ],
      } as never)) as { topics: string[] }[];
      candidates = tokenIdsFromLogs(logs);
    } catch {
      // One unreachable collection must not empty the whole wallet.
      continue;
    }

    for (const tokenId of candidates) {
      try {
        // A Transfer IN is not possession: it may have moved on since.
        const holder = await client.readContract({
          address: collection.address,
          abi: ERC721,
          functionName: "ownerOf",
          args: [tokenId],
        });
        if (holder.toLowerCase() !== wallet.toLowerCase()) continue;

        let name: string | null = null;
        let image: string | null = null;
        try {
          const uri = await client.readContract({
            address: collection.address,
            abi: ERC721,
            functionName: "tokenURI",
            args: [tokenId],
          });
          const url = toHttpUrl(uri);
          if (url && !url.startsWith("data:")) {
            const res = await fetch(url, {
              signal: AbortSignal.timeout(6_000),
            });
            if (res.ok) {
              const meta = readMetadata(await res.json());
              name = meta.name;
              image = meta.image;
            }
          }
        } catch {
          // Metadata is decoration. A token the chain says is hers still shows.
        }

        items.push({
          collection: collection.name,
          contract: collection.address,
          tokenId: tokenId.toString(),
          name,
          image,
        });
      } catch {
        // ownerOf reverts for a burned token. Skip it.
        continue;
      }
    }
  }

  return NextResponse.json({ items });
}
