// ---------------------------------------------------------------------------
// The Haz Mercado weekly board.
//
// RANKED ON POINTS PER MATCH, NOT TOTAL. A board that ranks the total is a board
// the player who plays most wins; the average is fair to someone who plays three
// matches, and the minimum stops one lucky match topping it.
//
// COMPUTED, NEVER REPORTED. Every number comes from finished MercadoMatch rows,
// which only the server writes. Nothing a browser sends can move a row here.
//
// OPT-IN. A player appears only with a CotasProfile marked listed, under the
// alias they chose. Their wallet never appears.
//
// The week starts Monday 00:00 in Mexico City. Mexico abolished daylight saving
// in 2022, so that is a fixed UTC-6: Monday 06:00 UTC.
// ---------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";

export const MIN_MATCHES = 3;
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
  matches: number;
  wins: number;
  /** Sum of final points, tenths of a bp. */
  points: number;
}

export interface Ranked extends Tally {
  rank: number;
  /** points / matches. */
  avg: number;
}

/** Pure: who qualifies and in what order. */
export function rank(tallies: Tally[]): Ranked[] {
  return tallies
    .filter((t) => t.matches >= MIN_MATCHES)
    .map((t) => ({ ...t, avg: t.points / t.matches }))
    .sort(
      (a, b) =>
        b.avg - a.avg || b.wins - a.wins || a.alias.localeCompare(b.alias),
    )
    .map((t, i) => ({ ...t, rank: i + 1 }));
}

interface TallyRow {
  playerId: string;
  alias: string;
  matches: bigint;
  wins: bigint;
  points: bigint | null;
}

async function tallies(since: Date, onlyPlayer?: string): Promise<Tally[]> {
  const rows = await prisma.$queryRaw<TallyRow[]>`
    SELECT m."playerId", COALESCE(p.alias, '') AS alias,
      COUNT(*) AS matches,
      COUNT(*) FILTER (WHERE m.you > 0) AS wins,
      SUM(m.you) AS points
    FROM "MercadoMatch" m
    LEFT JOIN "CotasProfile" p ON p."playerId" = m."playerId"
    WHERE m."finishedAt" >= ${since}
      AND (${onlyPlayer ?? null}::text IS NULL AND p.listed = true
           OR m."playerId" = ${onlyPlayer ?? null}::text)
    GROUP BY m."playerId", p.alias
  `;
  return rows.map((r) => ({
    playerId: r.playerId,
    alias: r.alias,
    matches: Number(r.matches),
    wins: Number(r.wins),
    points: Number(r.points ?? 0n),
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
    avg: t.matches ? t.points / t.matches : 0,
    qualifies: t.matches >= MIN_MATCHES,
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
