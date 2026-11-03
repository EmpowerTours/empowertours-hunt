// ---------------------------------------------------------------------------
// The Cotas weekly leaderboard.
//
// RANKED ON RETURN, NOT VOLUME. A board that ranks crossings or chips moved is a
// board the player who trades most wins, and in this game trading more is
// paying more fees. Return % is size-blind (500 MON and 5,000 MON compete on the
// same terms) and the 10-crossing minimum stops one lucky trade topping it.
//
// COMPUTED, NEVER REPORTED. Every number comes from CotasEvent, the append-only
// ledger the engine writes. Nothing a browser sends can move a row here.
//
// OPT-IN. A player appears only with a CotasProfile marked listed, under the
// alias they chose. Their wallet never appears.
//
// The week starts Monday 00:00 in Mexico City. Mexico abolished daylight saving
// in 2022, so that is a fixed UTC-6: Monday 06:00 UTC.
// ---------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";

export const MIN_CROSSINGS = 10;
const CDMX_OFFSET_MS = 6 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

/** Monday 00:00 America/Mexico_City of the week containing `now`, as a UTC instant. */
export function weekStart(now: number): number {
  const local = now - CDMX_OFFSET_MS;
  const day = new Date(local).getUTCDay(); // 0 = Sunday
  const sinceMonday = (day + 6) % 7;
  const midnight = Math.floor(local / DAY) * DAY;
  return midnight - sinceMonday * DAY + CDMX_OFFSET_MS;
}

export interface Tally {
  playerId: string;
  alias: string;
  /** Booked results minus opening fees this week, micro-chips. */
  net: number;
  crossings: number;
  escapes: number;
  /** Balance at the start of the week plus chips granted or refilled during it. */
  capital: number;
}

export interface Ranked extends Tally {
  rank: number;
  /** net / capital, as a fraction. */
  ret: number;
  /** crossings / (crossings + escapes). */
  hitRate: number;
}

/** Pure: who qualifies and in what order. */
export function rank(tallies: Tally[]): Ranked[] {
  return tallies
    .filter((t) => t.crossings >= MIN_CROSSINGS && t.capital > 0)
    .map((t) => ({
      ...t,
      ret: t.net / t.capital,
      hitRate: t.crossings / (t.crossings + t.escapes),
    }))
    .sort(
      (a, b) =>
        b.ret - a.ret ||
        b.hitRate - a.hitRate ||
        a.alias.localeCompare(b.alias),
    )
    .map((t, i) => ({ ...t, rank: i + 1 }));
}

interface TallyRow {
  playerId: string;
  alias: string;
  net: bigint | null;
  crossings: bigint;
  escapes: bigint;
  added: bigint | null;
  opening: bigint | null;
}

async function tallies(since: Date, onlyPlayer?: string): Promise<Tally[]> {
  const rows = await prisma.$queryRaw<TallyRow[]>`
    WITH week AS (
      SELECT e."playerId",
        SUM(CASE WHEN e.kind IN ('cross','escape') THEN e.pnl ELSE 0 END)
          - SUM(CASE WHEN e.kind = 'open' THEN e.fee ELSE 0 END) AS net,
        COUNT(*) FILTER (WHERE e.kind = 'cross') AS crossings,
        COUNT(*) FILTER (WHERE e.kind = 'escape') AS escapes,
        SUM(CASE WHEN e.kind IN ('grant','refill') THEN e.pnl ELSE 0 END) AS added
      FROM "CotasEvent" e
      WHERE e."candleAt" >= ${since}
      GROUP BY e."playerId"
    ),
    opening AS (
      SELECT DISTINCT ON (e."playerId") e."playerId", e."balanceAfter" AS opening
      FROM "CotasEvent" e
      WHERE e."candleAt" < ${since}
      ORDER BY e."playerId", e."candleAt" DESC, e."createdAt" DESC
    )
    SELECT w."playerId", COALESCE(p.alias, '') AS alias, w.net, w.crossings, w.escapes, w.added, o.opening
    FROM week w
    LEFT JOIN "CotasProfile" p ON p."playerId" = w."playerId"
    LEFT JOIN opening o ON o."playerId" = w."playerId"
    WHERE ${onlyPlayer ?? null}::text IS NULL AND p.listed = true
       OR w."playerId" = ${onlyPlayer ?? null}::text
  `;
  return rows.map((r) => ({
    playerId: r.playerId,
    alias: r.alias,
    net: Number(r.net ?? 0n),
    crossings: Number(r.crossings),
    escapes: Number(r.escapes),
    capital: Number(r.opening ?? 0n) + Number(r.added ?? 0n),
  }));
}

let cache: { at: number; week: number; board: Ranked[] } | null = null;
const TTL_MS = 60_000;

/** The public board for the current week, recomputed at most once a minute per instance. */
export async function weeklyBoard(
  now = Date.now(),
): Promise<{ weekStart: number; board: Ranked[] }> {
  const week = weekStart(now);
  if (!cache || cache.week !== week || now - cache.at >= TTL_MS) {
    const board = rank(await tallies(new Date(week)));
    // Concurrent recomputes write equally fresh boards; last writer wins.
    // eslint-disable-next-line require-atomic-updates
    cache = { at: now, week, board };
    return { weekStart: week, board };
  }
  return { weekStart: week, board: cache.board };
}

/** One player's own numbers this week, listed or not, qualifying or not. */
export async function myWeek(playerId: string, now = Date.now()) {
  const [t] = await tallies(new Date(weekStart(now)), playerId);
  if (!t) return null;
  return {
    ...t,
    ret: t.capital > 0 ? t.net / t.capital : 0,
    qualifies: t.crossings >= MIN_CROSSINGS,
  };
}

const ALIAS = /^[A-Za-z0-9_]{3,16}$/;

export function validAlias(a: unknown): a is string {
  return typeof a === "string" && ALIAS.test(a);
}

/** Set the alias and whether to be listed. Alias uniqueness is case-insensitive. */
export async function setProfile(
  playerId: string,
  alias: string,
  listed: boolean,
): Promise<"ok" | "taken"> {
  try {
    await prisma.cotasProfile.upsert({
      where: { playerId },
      create: { playerId, alias, aliasKey: alias.toLowerCase(), listed },
      update: { alias, aliasKey: alias.toLowerCase(), listed },
    });
    cache = null;
    return "ok";
  } catch (err) {
    if (
      typeof err === "object" &&
      err &&
      "code" in err &&
      (err as { code: string }).code === "P2002"
    )
      return "taken";
    throw err;
  }
}

export async function getProfile(playerId: string) {
  return prisma.cotasProfile.findUnique({
    where: { playerId },
    select: { alias: true, listed: true },
  });
}
