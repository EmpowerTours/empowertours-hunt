import { NextResponse } from "next/server";
import { isAddress, isHash } from "viem";
import { prisma } from "@/lib/db/prisma";
import { publicClient } from "@/lib/cota/swap";
import {
  NotAKuruTrade,
  toRecord,
  type MinimalReceipt,
} from "@/lib/cota/kuru-history";

// ---------------------------------------------------------------------------
// The hunter's own Kuru trades.
//
// POST records one. The body carries a HASH and a direction and nothing else —
// every other field is read back off the chain here. That is the whole design:
// a client that can only name a transaction cannot invent one, cannot mark a
// revert successful, and cannot claim the order book on a trade that went to a
// pool. `toRecord` rejects a transaction this wallet did not send and one that
// did not go to Kuru, so neither is storable.
//
// GET reads them back for an address. Scoped by a query parameter, which for
// this table is correct and for its neighbour would not be: CotaAgentDecision
// holds private reasoning and is scoped to the session's own playerId, whereas
// everything here is already on a public chain. Serving it discloses nothing an
// explorer would not, and it keeps working for a wallet-only hunter with no
// Player row. The honest reason to check a session would be rate limiting, and
// a session is not what limits a rate.
// ---------------------------------------------------------------------------

const MAX = 50;

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const { hash, side } = (body ?? {}) as { hash?: unknown; side?: unknown };

  if (typeof hash !== "string" || !isHash(hash)) {
    return NextResponse.json({ error: "hash required" }, { status: 400 });
  }
  if (side !== "buy" && side !== "sell") {
    return NextResponse.json(
      { error: "side must be buy or sell" },
      { status: 400 },
    );
  }

  // Already recorded. A retry, a double tap, or two tabs — one trade, one row.
  // Answered before touching an RPC so a hammering client costs us nothing.
  const seen = await prisma.kuruSwap.findUnique({
    where: { hash: hash.toLowerCase() },
  });
  if (seen) return NextResponse.json({ recorded: true, already: true });

  let receipt;
  let tx;
  try {
    [receipt, tx] = await Promise.all([
      publicClient().getTransactionReceipt({ hash }),
      publicClient().getTransaction({ hash }),
    ]);
  } catch {
    // Not mined yet, or not a transaction. Either way there is nothing to read,
    // and writing a row we could not verify is exactly what this endpoint
    // refuses to do. The client retries after the receipt lands.
    return NextResponse.json(
      { error: "no receipt for that hash yet" },
      { status: 404 },
    );
  }

  let record;
  try {
    record = toRecord(
      hash,
      receipt.from,
      tx.value,
      receipt as unknown as MinimalReceipt,
    );
  } catch (err) {
    if (err instanceof NotAKuruTrade) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  try {
    await prisma.kuruSwap.create({
      data: {
        hash: record.hash,
        wallet: record.wallet,
        ok: record.ok,
        blockNumber: record.blockNumber,
        // Wei as decimal strings — see the model. A 10 MON trade overflows a
        // Postgres BIGINT, and JSON cannot carry a bigint at all.
        gasWei: record.gasWei.toString(),
        valueWei: record.valueWei.toString(),
        side,
        tokensIn: Object.fromEntries(
          Object.entries(record.tokensIn).map(([t, u]) => [t, u.toString()]),
        ),
        crossedOrderBook: record.crossedOrderBook,
      },
    });
  } catch {
    // Two requests for the same hash can both pass the check above and race to
    // insert. The unique index is what actually decides; losing that race means
    // the row exists, which is the outcome the caller wanted.
    return NextResponse.json({ recorded: true, already: true });
  }

  return NextResponse.json({ recorded: true });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const wallet = url.searchParams.get("wallet");
  if (!wallet || !isAddress(wallet)) {
    return NextResponse.json({ error: "wallet required" }, { status: 400 });
  }
  const limit = Math.min(
    MAX,
    Math.max(1, Number(url.searchParams.get("limit") ?? 20) || 20),
  );

  const rows = await prisma.kuruSwap.findMany({
    where: { wallet: wallet.toLowerCase() },
    orderBy: { at: "desc" },
    take: limit,
    select: {
      hash: true,
      ok: true,
      side: true,
      gasWei: true,
      valueWei: true,
      tokensIn: true,
      crossedOrderBook: true,
      at: true,
    },
  });

  // blockNumber is deliberately not selected: it is a bigint and would fail
  // JSON serialisation. Nothing on the screen uses it.
  return NextResponse.json({ trades: rows });
}
