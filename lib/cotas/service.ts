// ---------------------------------------------------------------------------
// Cotas, persisted: load a player's game, catch it up with Perpl, save it.
//
// TWO TABS, ONE GAME. A player with the game open twice would otherwise apply
// the same minute of trading twice and book the same crossing twice. Every
// write is conditional on the version it read (optimistic lock); a writer that
// loses re-reads and tries once more, and a second loss is reported rather than
// retried forever.
//
// THE SERVER DECIDES. The browser sends walls and a size, nothing else. Prices
// come from Perpl here, fills are computed here, and the chips are counted
// here. There is no route that accepts a price, a fill or a balance.
//
// SERVER ONLY.
// ---------------------------------------------------------------------------

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { advance, cursorFrom, type Cursor, type TimedEvent } from "./advance";
import {
  CHIP,
  SIZES,
  START_CHIPS,
  checkWalls,
  clearWalls,
  leashLong,
  leashShort,
  newGame,
  openPnl,
  setWalls,
  type GameState,
  type Size,
  type Walls,
  type WallsRefusal,
} from "./engine";
import { FeedError, candlesSince, latestPrice, recentTrail } from "./feed";

/** Broke enough to refill: below this, the smallest size cannot open. */
export const REFILL_BELOW = 100 * CHIP;
const REFILL_EVERY_MS = 24 * 60 * 60 * 1000;

export class CotasError extends Error {
  constructor(
    public readonly code:
      "feed_unavailable" | "busy" | "walls_refused" | "holding" | "no_refill",
    public readonly reason?: WallsRefusal | string,
  ) {
    super(reason ? `${code}: ${reason}` : code);
    this.name = "CotasError";
  }
}

interface Row {
  id: string;
  state: GameState;
  cursor: Cursor;
  version: number;
  refilledAt: Date | null;
}

function toRow(r: {
  id: string;
  state: Prisma.JsonValue;
  cursor: Prisma.JsonValue;
  version: number;
  refilledAt: Date | null;
}): Row {
  return {
    id: r.id,
    state: r.state as unknown as GameState,
    cursor: r.cursor as unknown as Cursor,
    version: r.version,
    refilledAt: r.refilledAt,
  };
}

/** Event rows for the ledger. Recentres and skips move no chips and are not stored. */
function eventRows(
  playerId: string,
  before: GameState,
  events: TimedEvent[],
): Prisma.CotasEventCreateManyInput[] {
  let balance = before.balance;
  const rows: Prisma.CotasEventCreateManyInput[] = [];
  for (const { event: e, candleAt } of events) {
    if (e.kind === "open") {
      balance -= e.fee;
      rows.push({
        playerId,
        kind: "open",
        side: e.side,
        price: e.price,
        qty: e.qty,
        fee: BigInt(e.fee),
        balanceAfter: BigInt(balance),
        candleAt: new Date(candleAt),
      });
    } else if (e.kind === "cross" || e.kind === "escape") {
      balance += e.pnl;
      rows.push({
        playerId,
        kind: e.kind,
        side: e.side,
        price: e.price,
        entry: e.entry,
        qty: e.qty,
        pnl: BigInt(e.pnl),
        fee: BigInt(e.fee),
        balanceAfter: BigInt(balance),
        candleAt: new Date(candleAt),
      });
    }
  }
  return rows;
}

async function create(playerId: string): Promise<Row> {
  const latest = await latestPrice();
  if (!latest)
    throw new CotasError("feed_unavailable", "no MON trades returned");
  const state = newGame(latest.price);
  const cursor = cursorFrom({
    t: latest.t,
    o: latest.price,
    h: latest.price,
    l: latest.price,
    c: latest.price,
    n: 0,
  });
  try {
    const row = await prisma.$transaction(async (tx) => {
      const g = await tx.cotasGame.create({
        data: {
          playerId,
          state: state as unknown as Prisma.InputJsonValue,
          cursor: cursor as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.cotasEvent.create({
        data: {
          playerId,
          kind: "grant",
          pnl: BigInt(START_CHIPS),
          balanceAfter: BigInt(START_CHIPS),
          candleAt: new Date(),
        },
      });
      return g;
    });
    return toRow(row);
  } catch (err) {
    // Two first requests at once: the unique playerId lets exactly one create
    // (and grant). The other reads what it made.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const g = await prisma.cotasGame.findUniqueOrThrow({
        where: { playerId },
      });
      return toRow(g);
    }
    throw err;
  }
}

async function load(playerId: string): Promise<Row> {
  const g = await prisma.cotasGame.findUnique({ where: { playerId } });
  return g ? toRow(g) : create(playerId);
}

/** Write a new state if nobody else has since we read. */
async function save(
  playerId: string,
  row: Row,
  next: GameState,
  cursor: Cursor,
  events: TimedEvent[],
  extra: Prisma.CotasGameUpdateManyMutationInput = {},
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const r = await tx.cotasGame.updateMany({
      where: { id: row.id, version: row.version },
      data: {
        state: next as unknown as Prisma.InputJsonValue,
        cursor: cursor as unknown as Prisma.InputJsonValue,
        version: { increment: 1 },
        ...extra,
      },
    });
    if (r.count !== 1) return false;
    // One timestamp per row, a millisecond apart: rows written together would
    // otherwise share now(), and the log would show them in any order.
    const base = Date.now();
    const rows = eventRows(playerId, row.state, events).map((r, i) => ({
      ...r,
      createdAt: new Date(base + i),
    }));
    if (rows.length) await tx.cotasEvent.createMany({ data: rows });
    return true;
  });
}

/** Catch the game up with Perpl, then optionally change it, atomically. */
async function mutate(
  playerId: string,
  change?: (s: GameState) => GameState,
): Promise<Row> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await load(playerId);
    let candles;
    try {
      candles = await candlesSince(row.cursor.t);
    } catch (err) {
      if (err instanceof FeedError)
        throw new CotasError("feed_unavailable", err.message);
      throw err;
    }
    const caught = advance(row.state, row.cursor, candles);
    const next = change ? change(caught.state) : caught.state;
    if (
      next === row.state &&
      caught.events.length === 0 &&
      caught.cursor.t === row.cursor.t &&
      caught.cursor.close === row.cursor.close
    ) {
      return row;
    }
    if (await save(playerId, row, next, caught.cursor, caught.events)) {
      return {
        ...row,
        state: next,
        cursor: caught.cursor,
        version: row.version + 1,
      };
    }
  }
  throw new CotasError("busy");
}

export async function sync(playerId: string): Promise<Row> {
  return mutate(playerId);
}

export async function moveWalls(
  playerId: string,
  walls: Walls,
  qty: number,
): Promise<Row> {
  return mutate(playerId, (s) => {
    const ok = checkWalls(s, walls, qty);
    if (!ok.ok) throw new CotasError("walls_refused", ok.reason);
    return setWalls(s, walls, qty as Size);
  });
}

export async function takeDown(playerId: string): Promise<Row> {
  return mutate(playerId, (s) => {
    if (s.pos !== 0) throw new CotasError("holding");
    return clearWalls(s);
  });
}

export function canRefill(row: Row, now = Date.now()): boolean {
  return (
    row.state.pos === 0 &&
    row.state.balance < REFILL_BELOW &&
    (!row.refilledAt || now - row.refilledAt.getTime() >= REFILL_EVERY_MS)
  );
}

/**
 * Top a broke player back up to 1,000 chips, at most once a day. The loss that
 * emptied them stays in the ledger and therefore on the leaderboard: a refill
 * buys another go, never a better week.
 */
export async function refill(playerId: string): Promise<Row> {
  const row = await sync(playerId);
  if (!canRefill(row)) throw new CotasError("no_refill");
  const added = START_CHIPS - row.state.balance;
  const next: GameState = { ...row.state, balance: START_CHIPS };
  const ok = await prisma.$transaction(async (tx) => {
    const r = await tx.cotasGame.updateMany({
      where: { id: row.id, version: row.version },
      data: {
        state: next as unknown as Prisma.InputJsonValue,
        version: { increment: 1 },
        refilledAt: new Date(),
      },
    });
    if (r.count !== 1) return false;
    await tx.cotasEvent.create({
      data: {
        playerId,
        kind: "refill",
        pnl: BigInt(added),
        balanceAfter: BigInt(START_CHIPS),
        candleAt: new Date(),
      },
    });
    return true;
  });
  if (!ok) throw new CotasError("busy");
  return {
    ...row,
    state: next,
    version: row.version + 1,
    refilledAt: new Date(),
  };
}

/** What the screen needs. Amounts stay in micro-chips; the client formats. */
export async function view(playerId: string, row: Row) {
  const s = row.state;
  const trail = await recentTrail().catch(() => []);
  const recent = await prisma.cotasEvent.findMany({
    where: {
      playerId,
      kind: { in: ["open", "cross", "escape", "refill", "grant"] },
    },
    orderBy: [{ createdAt: "desc" }],
    take: 25,
    select: {
      id: true,
      kind: true,
      side: true,
      price: true,
      entry: true,
      qty: true,
      pnl: true,
      fee: true,
      balanceAfter: true,
      candleAt: true,
    },
  });
  return {
    price: s.last,
    walls: s.walls,
    leash: s.walls
      ? { long: leashLong(s.walls), short: leashShort(s.walls) }
      : null,
    qty: s.qty,
    next: s.next ?? null,
    sizes: SIZES,
    pos: s.pos,
    entry: s.entry,
    armed: s.armed,
    balance: s.balance,
    openPnl: openPnl(s, s.last),
    crossings: s.crossings,
    escapes: s.escapes,
    streak: s.streak,
    bestStreak: s.bestStreak,
    fees: s.fees,
    canRefill: canRefill(row),
    cursorAt: row.cursor.t,
    trail,
    recent: recent.map((e) => ({
      ...e,
      pnl: e.pnl === null ? null : Number(e.pnl),
      fee: e.fee === null ? null : Number(e.fee),
      balanceAfter: Number(e.balanceAfter),
      candleAt: e.candleAt.getTime(),
    })),
  };
}
