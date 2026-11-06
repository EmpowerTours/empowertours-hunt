// ---------------------------------------------------------------------------
// Cota Práctica, persisted: load a player's match, bring it up to now with
// Perpl's real candles, apply a move, save it.
//
// TWO TABS, ONE MATCH. Every write is conditional on the version it read
// (optimistic lock). A writer that loses re-reads and tries once more; a second
// loss is reported as busy rather than retried forever.
//
// THE SERVER DECIDES. The browser sends intentions only: start, a quote (two
// walls), or buy / sell / pass. The reference price, the bot's moves, the clock
// and the settling close are all taken here. No route accepts a price as fact
// or a result.
//
// SERVER ONLY.
// ---------------------------------------------------------------------------

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import {
  GameError,
  MINUTE,
  ROUNDS,
  current,
  deadline,
  finished,
  newMatch,
  pending,
  quote,
  score,
  spreadLimits,
  take,
  tick,
  typicalMove,
  type Candle,
  type Market,
  type Match,
} from "./game";
import { FeedError, candlesSince, latestPrice, recentTrail } from "./feed";

export class MercadoError extends Error {
  constructor(
    public readonly code: "feed_unavailable" | "busy" | "refused",
    public readonly reason?: string,
  ) {
    super(reason ? `${code}: ${reason}` : code);
    this.name = "MercadoError";
  }
}

interface Row {
  id: string;
  match: Match;
  version: number;
}

async function market(): Promise<{
  market: Market;
  trail: Array<{ t: number; p: number }>;
}> {
  try {
    const [latest, trail] = await Promise.all([latestPrice(), recentTrail()]);
    return {
      market: { price: latest?.price ?? null, closes: trail.map((x) => x.p) },
      trail,
    };
  } catch (err) {
    if (err instanceof FeedError)
      throw new MercadoError("feed_unavailable", err.message);
    throw err;
  }
}

async function candlesFor(m: Match): Promise<Candle[]> {
  const waiting = pending(m)
    .map((r) => r.settleT)
    .filter((t): t is number => t !== null);
  if (!waiting.length) return [];
  try {
    // One minute earlier than the first, so a minute with no trades can be
    // settled at the price before it.
    return await candlesSince(Math.min(...waiting) - MINUTE);
  } catch (err) {
    if (err instanceof FeedError) return []; // settle on a later poll
    throw err;
  }
}

async function active(playerId: string): Promise<Row | null> {
  const r = await prisma.mercadoMatch.findFirst({
    where: { playerId, finishedAt: null },
    orderBy: { createdAt: "desc" },
  });
  return r
    ? { id: r.id, match: r.state as unknown as Match, version: r.version }
    : null;
}

async function save(row: Row, next: Match): Promise<boolean> {
  const done = finished(next);
  const res = await prisma.mercadoMatch.updateMany({
    where: { id: row.id, version: row.version },
    data: {
      state: next as unknown as Prisma.InputJsonValue,
      version: { increment: 1 },
      ...(done ? { you: score(next), finishedAt: new Date() } : {}),
    },
  });
  return res.count === 1;
}

/**
 * Load the active match, bring it up to now, then apply `move` (if any) and
 * save. Retries once on a lost race.
 */
async function step(
  playerId: string,
  move?: (m: Match, mk: Market, now: number) => Match,
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await active(playerId);
    const { market: mk, trail } = await market();
    if (!row) {
      if (move) throw new MercadoError("refused", "no_match");
      // Between matches, show the last one: its final score stays on screen
      // until the player starts another.
      const last = await prisma.mercadoMatch.findFirst({
        where: { playerId, finishedAt: { not: null } },
        orderBy: { finishedAt: "desc" },
        select: { state: true },
      });
      return {
        row: null,
        match: last ? (last.state as unknown as Match) : null,
        market: mk,
        trail,
      };
    }
    const now = Date.now();
    const ticked = tick(
      row.match,
      now,
      mk,
      await candlesFor(row.match),
      Math.random,
    );
    let next = ticked.match;
    if (move) {
      try {
        next = move(next, mk, now);
      } catch (err) {
        if (err instanceof GameError)
          throw new MercadoError(
            err.code === "feed_unavailable" ? "feed_unavailable" : "refused",
            err.code,
          );
        throw err;
      }
      // The bot's answer to a quote, or the next round, opens straight away.
      next = tick(next, now, mk, [], Math.random).match;
    }
    if (!ticked.changed && !move)
      return { row, match: next, market: mk, trail };
    if (await save(row, next)) return { row, match: next, market: mk, trail };
  }
  throw new MercadoError("busy");
}

export async function sync(playerId: string) {
  return step(playerId);
}

export async function start(playerId: string) {
  const existing = await active(playerId);
  if (!existing) {
    const { market: mk } = await market();
    if (mk.price === null)
      throw new MercadoError("feed_unavailable", "no MON trades returned");
    const now = Date.now();
    const m = tick(newMatch(now), now, mk, [], Math.random).match;
    try {
      await prisma.mercadoMatch.create({
        data: { playerId, state: m as unknown as Prisma.InputJsonValue },
      });
    } catch (err) {
      // Another tab started one first (MercadoMatch_one_active_per_player):
      // play that one.
      if (
        !(err instanceof Prisma.PrismaClientKnownRequestError) ||
        err.code !== "P2002"
      )
        throw err;
    }
  }
  return step(playerId);
}

/** `below` / `above`: how many ticks from the live price to put each wall. */
export async function placeQuote(
  playerId: string,
  below: number,
  above: number,
) {
  return step(playerId, (m, mk, now) =>
    quote(m, now, mk, below, above, Math.random),
  );
}

export async function takeQuote(
  playerId: string,
  action: "buy" | "sell" | "pass",
) {
  return step(playerId, (m, _mk, now) => take(m, now, action));
}

/** Everything the screen needs. Nothing here is secret: the bot's quote is meant to be seen. */
export async function view(
  playerId: string,
  s: Awaited<ReturnType<typeof step>>,
) {
  const recent = await prisma.mercadoMatch.findMany({
    where: { playerId, finishedAt: { not: null } },
    orderBy: { finishedAt: "desc" },
    take: 5,
    select: { id: true, you: true, finishedAt: true },
  });
  const m = s.match;
  const cur = m ? current(m) : null;
  return {
    serverNow: Date.now(),
    price: s.market.price,
    trail: s.trail,
    limits: s.market.price ? spreadLimits(s.market.price) : null,
    /** Median one-minute move lately, ticks: the default distance for a wall. */
    typical: s.market.price
      ? typicalMove(s.market.closes, s.market.price)
      : null,
    rounds: ROUNDS,
    match: m && {
      you: score(m),
      passes: m.passes,
      finished: finished(m),
      current: cur && { n: cur.n, quoter: cur.quoter, deadline: deadline(cur) },
      rounds: m.rounds.map((r) => ({
        n: r.n,
        quoter: r.quoter,
        ref: r.ref,
        bid: r.bid,
        ask: r.ask,
        action: r.action,
        lockedAt: r.lockedAt,
        settleAt: r.settleT === null ? null : r.settleT + MINUTE,
        close: r.close,
        you: r.you,
      })),
    },
    history: recent.map((r) => ({
      id: r.id,
      you: r.you ?? 0,
      at: r.finishedAt?.getTime() ?? 0,
    })),
  };
}
