import { NextResponse } from "next/server";
import { AuthError, requirePlayer } from "@/lib/auth";
import { prisma } from "@/lib/db/prisma";
import { publicClient } from "@/lib/cota/swap";
import { AUSD, USDC } from "@/lib/cota/kuru";

// ---------------------------------------------------------------------------
// Where the judge has actually got to.
//
// WHY THIS EXISTS. A checklist is a menu: it asks the reader to keep score of
// their own progress through somebody else's product, which is work. This route
// lets the walkthrough keep score instead — it reads the real state and the
// screen advances on its own. Signing in ticks a step. A leash appearing ticks
// the next. A deposit landing ticks the one after that, with no button to press
// and nothing to claim.
//
// EVERY FLAG IS AN OBSERVATION, NEVER AN ASSERTION FROM THE CLIENT. The wallet
// comes from the session, the leash from our table, the balances from Monad. A
// judge cannot mark their own homework and neither can we.
//
// Steps that cannot be observed — reading a file on GitHub, installing the APK
// — are absent here on purpose. The page marks those by hand, and it is better
// that the honest half is automatic than that the whole thing pretends.
// ---------------------------------------------------------------------------

const ERC20 = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** Enough MON to anchor a leash — the threshold that makes the next step possible. */
const ANCHOR_GAS_WEI = 20_000_000_000_000_000n; // 0.02 MON

export async function GET(req: Request) {
  let player;
  try {
    player = await requirePlayer(req);
  } catch (err) {
    if (err instanceof AuthError) {
      // Not an error: it is step one, unfinished.
      return NextResponse.json({ signedIn: false });
    }
    throw err;
  }

  const wallet = player.walletAddress as `0x${string}`;

  const [leash, anchored, note, address, chain] = await Promise.all([
    prisma.cota.findFirst({
      where: { playerId: player.id, revokedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, anchorTxHash: true, markets: true },
    }),
    prisma.cota.findFirst({
      where: { playerId: player.id, anchorTxHash: { not: null } },
      select: { anchorTxHash: true },
    }),
    prisma.cotaNote.findFirst({ where: { playerId: player.id }, select: { id: true } }),
    prisma.auroraDepositAddress.findFirst({
      where: { playerId: player.id },
      select: { depositAddress: true, destinationAsset: true },
    }),
    (async () => {
      // One RPC round trip for the three balances the walkthrough gates on.
      try {
        const pc = publicClient();
        const [mon, usdc, ausd] = await Promise.all([
          pc.getBalance({ address: wallet }),
          pc.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [wallet] }) as Promise<bigint>,
          pc.readContract({ address: AUSD, abi: ERC20, functionName: "balanceOf", args: [wallet] }) as Promise<bigint>,
        ]);
        return { mon, usdc, ausd };
      } catch {
        // A chain read that fails must not report empty balances — that would
        // un-tick a step the judge already completed and send them round again.
        return null;
      }
    })(),
  ]);

  return NextResponse.json({
    signedIn: true,
    wallet,
    hasLeash: leash !== null && leash.markets.length > 0,
    anchored: anchored !== null,
    anchorTxHash: anchored?.anchorTxHash ?? null,
    hasNote: note !== null,
    hasDepositAddress: address !== null,
    depositAddress: address?.depositAddress ?? null,
    // null means "we could not look", which the page renders as unknown rather
    // than as zero.
    funded: chain === null ? null : chain.mon >= ANCHOR_GAS_WEI,
    hasAusd: chain === null ? null : chain.ausd > 0n,
    hasUsdc: chain === null ? null : chain.usdc > 0n,
  });
}
