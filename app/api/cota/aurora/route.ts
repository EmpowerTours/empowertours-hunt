import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requirePlayer } from "@/lib/auth";
import { prisma } from "@/lib/db/prisma";
import {
  AuroraError,
  DEPOSIT_TYPES,
  isDepositChain,
  readPersistentDeposits,
  requestPersistentDepositAddress,
  type DepositChain,
} from "@/lib/cota/aurora";

// ---------------------------------------------------------------------------
// GET/POST /api/cota/aurora — the hunter's any-chain deposit address.
//
// WHY A HUNTER NEEDS THIS. Every other funding route in Cota assumes the money
// is already on Monad, or already AUSD somewhere we bridge from. A hunter whose
// value sits on Solana, on Bitcoin, on Base, or on an exchange has no way in at
// all. Aurora hands out one address that accepts any of those and delivers USDC
// on Monad, which is the exact token lib/cota/kuru.ts already swaps to AUSD.
//
// THE ONE THING THIS ROUTE MUST NEVER GET WRONG is whose address it returns.
// `sender` is Aurora's idempotency key: the same sender yields the same address
// forever, and two hunters sharing a sender would share incoming money. It is
// taken from the session, never from the request body, so a client cannot ask
// for another hunter's address because it cannot name one.
//
// WHY THE SENDER IS THE WALLET AND NOT THE PLAYER ID. Both are unique per
// hunter, so either would be safe. The difference is what survives losing this
// database. A player id is a cuid this database invented: restore from a backup
// and it is still there, but lose the rows and a returning hunter registers
// again as a NEW id, so we would ask Aurora for an address under a sender that
// has never existed and be handed a different one.
//
// The wallet address is derived from the hunter's passkey (lib/auth/derive.ts)
// and is reproducible on any device, forever, with no server involved. Using it
// as the sender makes this table PURELY a cache: drop it entirely and every
// hunter's address is recoverable by asking Aurora the same question again.
// That is the whole mitigation — not backups, arithmetic.
//
// FAILS CLOSED WITHOUT A KEY. With AURORA_INTENTS_APP_KEY unset the module
// throws, and this route answers 503 `unconfigured` rather than 500. The
// funding screen reads that as "do not offer this route" and shows only the
// paths that need no key, which is the behaviour AGENTS.md documents.
// ---------------------------------------------------------------------------

/**
 * `evm` is a shortcut, not a chain: one address that accepts funds from every
 * EVM chain Aurora supports. It is the default because it is the widest single
 * answer to "where do I send money", and a hunter should not have to choose a
 * chain before they can be told an address.
 */
const DEFAULT_CHAIN: DepositChain = "evm";

/**
 * Lowercased, because `requirePlayer` lowercases the wallet it looks up and a
 * sender that differed only in case would be a DIFFERENT sender to Aurora — a
 * second address for one hunter, which is the exact failure the unique
 * constraint on this table exists to prevent.
 */
function senderFor(walletAddress: string): string {
  return walletAddress.toLowerCase();
}

const Post = z.object({
  depositChain: z
    .string()
    .refine(isDepositChain, "not a chain Aurora accepts")
    .optional(),
});

const Type = z.enum(DEPOSIT_TYPES);

function fail(err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (err instanceof AuroraError) {
    // An unset key and a 500 from Aurora are both "this route is not available
    // right now", and neither is the hunter's problem to distinguish.
    const unconfigured = /is not set/.test(err.message);
    return NextResponse.json(
      { error: unconfigured ? "unconfigured" : "upstream" },
      { status: 503 },
    );
  }
  throw err;
}

/** The address we already hold, if any. Never calls Aurora. */
export async function GET(req: Request) {
  try {
    const player = await requirePlayer(req);
    const url = new URL(req.url);
    const chain = url.searchParams.get("depositChain") ?? DEFAULT_CHAIN;
    if (!isDepositChain(chain)) {
      return NextResponse.json({ error: "bad_chain" }, { status: 400 });
    }

    const row = await prisma.auroraDepositAddress.findUnique({
      where: {
        playerId_depositChain: { playerId: player.id, depositChain: chain },
      },
    });
    if (row === null) {
      return NextResponse.json({ address: null, depositChain: chain });
    }

    // Deposit history is only fetched when asked for, because it is a network
    // call per bucket and a hunter opening the screen usually wants the address.
    const typeParam = url.searchParams.get("type");
    if (typeParam === null) {
      return NextResponse.json({
        address: row.depositAddress,
        depositChain: row.depositChain,
        recipient: row.recipient,
      });
    }
    // `all` is ours, not Aurora's: their endpoint filters to one bucket, but a
    // hunter watching for their money wants both halves of the journey at once
    // — what left the origin chain and what arrived on Monad. Fetched in
    // parallel so the screen costs one round trip rather than two.
    let deposits;
    if (typeParam === "all") {
      const [received, success] = await Promise.all([
        readPersistentDeposits(row.depositAddress, "received"),
        readPersistentDeposits(row.depositAddress, "success"),
      ]);
      deposits = [...success, ...received];
    } else {
      const parsed = Type.safeParse(typeParam);
      if (!parsed.success) {
        return NextResponse.json({ error: "bad_type" }, { status: 400 });
      }
      deposits = await readPersistentDeposits(row.depositAddress, parsed.data);
    }
    return NextResponse.json({
      address: row.depositAddress,
      depositChain: row.depositChain,
      recipient: row.recipient,
      deposits,
    });
  } catch (err) {
    return fail(err);
  }
}

/** Issue the address, or hand back the one we already issued. */
export async function POST(req: Request) {
  try {
    const player = await requirePlayer(req);

    const body = Post.safeParse(await req.json().catch(() => ({})));
    if (!body.success) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const depositChain = body.data.depositChain ?? DEFAULT_CHAIN;

    const existing = await prisma.auroraDepositAddress.findUnique({
      where: { playerId_depositChain: { playerId: player.id, depositChain } },
    });
    // The recipient is checked, not just the presence of a row: an address that
    // pays a wallet this hunter no longer uses is worse than no address.
    if (existing !== null && existing.recipient === player.walletAddress) {
      return NextResponse.json({
        address: existing.depositAddress,
        depositChain,
        recipient: existing.recipient,
        fresh: false,
      });
    }

    const issued = await requestPersistentDepositAddress({
      recipient: player.walletAddress,
      sender: senderFor(player.walletAddress),
      depositChain,
    });

    const row = await prisma.auroraDepositAddress.upsert({
      where: { playerId_depositChain: { playerId: player.id, depositChain } },
      create: {
        playerId: player.id,
        depositChain,
        depositAddress: issued.depositAddress,
        recipient: player.walletAddress,
        sender: senderFor(player.walletAddress),
        reissued: issued.alreadyExists,
      },
      update: {
        depositAddress: issued.depositAddress,
        recipient: player.walletAddress,
        reissued: issued.alreadyExists,
      },
    });

    return NextResponse.json({
      address: row.depositAddress,
      depositChain,
      recipient: row.recipient,
      fresh: !issued.alreadyExists,
    });
  } catch (err) {
    return fail(err);
  }
}
