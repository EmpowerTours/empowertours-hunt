import { NextResponse } from "next/server";
import { createPublicClient, http, parseAbi } from "viem";
import { requirePlayer, AuthError } from "@/lib/auth";
import { prisma } from "@/lib/db/prisma";
import { monad } from "@/lib/monad";
import {
  TRANSFER_TOPIC,
  collectionsForPlayer,
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
  "function name() view returns (string)",
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
  let playerId: string;
  try {
    const player = await requirePlayer(req);
    wallet = player.walletAddress;
    playerId = player.id;
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    throw e;
  }

  // Editions are not one contract: each work lives in its artist's own
  // collection, so the addresses come from this hunter's own claims rather
  // than a list. Nobody is scanned against collections they never touched.
  const claimed = await prisma.editionClaim.findMany({
    where: { playerId },
    select: { collection: true },
    distinct: ["collection"],
  });

  const client = createPublicClient({ chain: monad, transport: http(LOG_RPC) });
  const owner = addressTopic(wallet);
  const items: Collectible[] = [];

  for (const collection of collectionsForPlayer(claimed)) {
    // Ask the contract what it is called. A collection discovered through a
    // claim is labelled "Editions", which told the owner of three of them
    // nothing about what they were. name() is the collection's own answer.
    let label = collection.name;
    try {
      const onChain = await client.readContract({
        address: collection.address,
        abi: ERC721,
        functionName: "name",
      });
      if (typeof onChain === "string" && onChain.trim() !== "") {
        label = onChain.trim();
      }
    } catch {
      // Not every ERC-721 implements name(). Keep the configured label.
    }

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
          collection: label,
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
