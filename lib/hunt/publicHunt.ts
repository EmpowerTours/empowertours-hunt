// ---------------------------------------------------------------------------
// The public shape of a hunt.
//
// ## What is NOT here is the point
//
// No cache coordinates, no cache count, no centroid, no bounding box. Cache
// locations are the whole defence of the find economy — `README.md` lists
// secrecy as the mechanism, against spawns' movement plausibility — and a
// "roughly where" is still a search area. One cache in a rounded centroid is
// not obscured by rounding; it is a circle to walk.
//
// The hunt's own name and description carry the geography a person needs
// ("Tierra Colorada, centro"). That is a human deciding what to reveal, which
// is the right way for a secret to become public.
//
// Shape mirrors `PublicHunt` in components/hunt/types.ts. The client was
// written against this contract before the route existed; this file exists so
// the two cannot drift silently.
// ---------------------------------------------------------------------------

/** Exactly the columns a public reader may see. Passed straight to Prisma. */
export const PUBLIC_HUNT_SELECT = {
  id: true,
  name: true,
  description: true,
  active: true,
  startsAt: true,
  endsAt: true,
  maxAccuracyM: true,
  cooldownSeconds: true,
  spawnEnabled: true,
  spawnMaxRadiusM: true,
} as const;

export interface PublicHuntRow {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  maxAccuracyM: number;
  cooldownSeconds: number;
  spawnEnabled: boolean;
  spawnMaxRadiusM: number;
}

export interface PublicHuntJson {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
  maxAccuracyM: number;
  cooldownSeconds: number;
  spawnEnabled: boolean;
  spawnMaxRadiusM: number;
  remaining?: number;
}

/**
 * Serialise one row.
 *
 * `remaining` is this player's own remaining finds and is omitted entirely for
 * an anonymous reader — not sent as null, because the client's parser treats a
 * missing field as "unknown" and a number as "known", and an anonymous browser
 * genuinely does not have one.
 */
export function toPublicHunt(
  row: PublicHuntRow,
  remaining?: number,
): PublicHuntJson {
  const json: PublicHuntJson = {
    id: row.id,
    name: row.name,
    description: row.description,
    active: row.active,
    startsAt: row.startsAt === null ? null : row.startsAt.toISOString(),
    endsAt: row.endsAt === null ? null : row.endsAt.toISOString(),
    maxAccuracyM: row.maxAccuracyM,
    cooldownSeconds: row.cooldownSeconds,
    spawnEnabled: row.spawnEnabled,
    spawnMaxRadiusM: row.spawnMaxRadiusM,
  };
  if (remaining !== undefined) json.remaining = remaining;
  return json;
}

/**
 * Is this hunt worth showing to somebody browsing?
 *
 * Ended hunts are hidden; hunts that have not started yet are NOT. A hunt
 * opening on Friday is the single most useful thing a browser can learn, and
 * the client already renders `startsAt`. Hiding it would leave the list empty
 * on exactly the days a campaign is driving people to it.
 */
export function isListable(row: PublicHuntRow, now: Date): boolean {
  if (!row.active) return false;
  if (row.endsAt !== null && row.endsAt.getTime() < now.getTime()) return false;
  return true;
}

/**
 * Remaining finds for a player on a hunt.
 *
 * `maxFindsPerPlayer === 0` means no cap, and the honest answer there is
 * "unknown" rather than a large number somebody might render as a countdown.
 */
export function remainingFinds(
  maxFindsPerPlayer: number,
  findCount: number,
): number | undefined {
  if (maxFindsPerPlayer <= 0) return undefined;
  const left = maxFindsPerPlayer - findCount;
  return left > 0 ? left : 0;
}
