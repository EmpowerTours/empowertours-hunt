// Parsing and validation for hunt and cache configuration.
//
// Every wei field arrives as a human MON string and goes through
// `parseMonInput`, which refuses "1e18", "0x10", "0x", " 5 ", "", negatives
// and anything finer than 18 decimal places. That matters because the naive
// alternative, `BigInt(input)`, accepts "0x10" as 16 wei and throws on
// "0.5" — one silently wrong, one wrong at the worst possible moment.
//
// `spentCreditWei` and `spentMonWei` are deliberately NOT settable here. They
// are atomic counters owned by the verifier and payout lanes; an admin editing
// them would break the conditional UPDATE that bounds every budget.

import { Prisma } from "@prisma/client";
import { fromWei, parseMonInput } from "@/lib/wei";
import {
  AdminInputError,
  optionalBool,
  optionalInt,
  optionalString,
} from "@/lib/admin/http";

/** Decimal(78,0)-safe value for Prisma, from a MON-denominated admin string. */
function weiField(
  body: Record<string, unknown>,
  field: string,
): Prisma.Decimal | undefined {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" && typeof raw !== "number") {
    throw new AdminInputError(`${field} must be a decimal MON string`);
  }
  try {
    return new Prisma.Decimal(fromWei(parseMonInput(String(raw))));
  } catch (e) {
    throw new AdminInputError(
      `${field}: ${e instanceof Error ? e.message : "not a valid MON amount"}`,
    );
  }
}

function dateField(
  body: Record<string, unknown>,
  field: string,
): Date | null | undefined {
  const raw = body[field];
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string") {
    throw new AdminInputError(`${field} must be an ISO date string`);
  }
  const d = new Date(raw);
  // `!(valid)` rather than `isNaN(...)` inverted, for the same reason as
  // everywhere else: an Invalid Date must not fall through as acceptable.
  if (!(d.getTime() === d.getTime())) {
    throw new AdminInputError(`${field} is not a valid date`);
  }
  return d;
}

export interface HuntWriteInput {
  name?: string;
  description?: string | null;
  active?: boolean;
  startsAt?: Date | null;
  endsAt?: Date | null;
  maxAccuracyM?: number;
  maxSpeedKmh?: number;
  cooldownSeconds?: number;
  maxClockSkewSeconds?: number;
  budgetCreditWei?: Prisma.Decimal;
  maxFindsPerPlayer?: number;
  spawnEnabled?: boolean;
  budgetMonWei?: Prisma.Decimal;
  spawnMinWei?: Prisma.Decimal;
  spawnMaxWei?: Prisma.Decimal;
  spawnMinRadiusM?: number;
  spawnMaxRadiusM?: number;
  spawnTtlSeconds?: number;
  spawnCooldownSeconds?: number;
  spawnDailyCapWeiPerPlayer?: Prisma.Decimal;
  autoApproveMaxWei?: Prisma.Decimal;
  autoApproveDailyCapWei?: Prisma.Decimal;
}

/** Sensible starting point for a new hunt: ~0.001 MON spawns, human gate on. */
export const HUNT_DEFAULTS = {
  maxAccuracyM: 30,
  maxSpeedKmh: 60,
  cooldownSeconds: 60,
  maxClockSkewSeconds: 120,
  maxFindsPerPlayer: 0,
  spawnMinRadiusM: 80,
  spawnMaxRadiusM: 600,
  spawnTtlSeconds: 900,
  spawnCooldownSeconds: 600,
  spawnMinMon: "0.0005",
  spawnMaxMon: "0.0015",
  autoApproveMaxMon: "0",
  autoApproveDailyCapMon: "0",
} as const;

export function parseHuntInput(
  body: Record<string, unknown>,
  mode: "create" | "update",
): HuntWriteInput {
  const out: HuntWriteInput = {};

  const name = optionalString(body, "name", 120);
  if (name !== undefined) {
    if (name.length < 3)
      throw new AdminInputError("name must be at least 3 characters");
    out.name = name;
  } else if (mode === "create") {
    throw new AdminInputError("name is required");
  }

  const description = optionalString(body, "description", 2000);
  if (description !== undefined) out.description = description || null;

  const active = optionalBool(body, "active");
  if (active !== undefined) out.active = active;

  const startsAt = dateField(body, "startsAt");
  if (startsAt !== undefined) out.startsAt = startsAt;
  const endsAt = dateField(body, "endsAt");
  if (endsAt !== undefined) out.endsAt = endsAt;

  // --- verifier rules ---
  const maxAccuracyM = optionalInt(body, "maxAccuracyM", 1, 500);
  if (maxAccuracyM !== undefined) out.maxAccuracyM = maxAccuracyM;
  const maxSpeedKmh = optionalInt(body, "maxSpeedKmh", 1, 1000);
  if (maxSpeedKmh !== undefined) out.maxSpeedKmh = maxSpeedKmh;
  const cooldownSeconds = optionalInt(body, "cooldownSeconds", 0, 86_400);
  if (cooldownSeconds !== undefined) out.cooldownSeconds = cooldownSeconds;
  const maxClockSkewSeconds = optionalInt(body, "maxClockSkewSeconds", 5, 3600);
  if (maxClockSkewSeconds !== undefined) {
    out.maxClockSkewSeconds = maxClockSkewSeconds;
  }

  // --- credit ---
  const budgetCreditWei = weiField(body, "budgetCreditMon");
  if (budgetCreditWei !== undefined) out.budgetCreditWei = budgetCreditWei;
  const maxFindsPerPlayer = optionalInt(body, "maxFindsPerPlayer", 0, 10_000);
  if (maxFindsPerPlayer !== undefined)
    out.maxFindsPerPlayer = maxFindsPerPlayer;

  // --- spawns (real MON) ---
  const spawnEnabled = optionalBool(body, "spawnEnabled");
  if (spawnEnabled !== undefined) out.spawnEnabled = spawnEnabled;

  const budgetMonWei = weiField(body, "budgetMon");
  if (budgetMonWei !== undefined) out.budgetMonWei = budgetMonWei;
  const spawnMinWei = weiField(body, "spawnMinMon");
  if (spawnMinWei !== undefined) out.spawnMinWei = spawnMinWei;
  const spawnMaxWei = weiField(body, "spawnMaxMon");
  if (spawnMaxWei !== undefined) out.spawnMaxWei = spawnMaxWei;

  const spawnMinRadiusM = optionalInt(body, "spawnMinRadiusM", 1, 50_000);
  if (spawnMinRadiusM !== undefined) out.spawnMinRadiusM = spawnMinRadiusM;
  const spawnMaxRadiusM = optionalInt(body, "spawnMaxRadiusM", 1, 100_000);
  if (spawnMaxRadiusM !== undefined) out.spawnMaxRadiusM = spawnMaxRadiusM;
  const spawnTtlSeconds = optionalInt(body, "spawnTtlSeconds", 30, 86_400);
  if (spawnTtlSeconds !== undefined) out.spawnTtlSeconds = spawnTtlSeconds;
  const spawnCooldownSeconds = optionalInt(
    body,
    "spawnCooldownSeconds",
    0,
    86_400,
  );
  if (spawnCooldownSeconds !== undefined) {
    out.spawnCooldownSeconds = spawnCooldownSeconds;
  }

  const spawnDailyCap = weiField(body, "spawnDailyCapMonPerPlayer");
  if (spawnDailyCap !== undefined)
    out.spawnDailyCapWeiPerPlayer = spawnDailyCap;

  // --- auto-approval policy ---
  const autoApproveMaxWei = weiField(body, "autoApproveMaxMon");
  if (autoApproveMaxWei !== undefined)
    out.autoApproveMaxWei = autoApproveMaxWei;
  const autoApproveDailyCapWei = weiField(body, "autoApproveDailyCapMon");
  if (autoApproveDailyCapWei !== undefined) {
    out.autoApproveDailyCapWei = autoApproveDailyCapWei;
  }

  return out;
}

/**
 * Cross-field checks, run against the MERGED row (existing values plus the
 * patch) so a partial update cannot sneak past a bound that the other half of
 * the pair still satisfies.
 */
export function validateHuntConsistency(merged: {
  spawnMinWei: Prisma.Decimal;
  spawnMaxWei: Prisma.Decimal;
  spawnMinRadiusM: number;
  spawnMaxRadiusM: number;
  startsAt: Date | null;
  endsAt: Date | null;
  spawnEnabled: boolean;
  budgetMonWei: Prisma.Decimal;
  autoApproveMaxWei: Prisma.Decimal;
}): void {
  if (merged.spawnMinWei.greaterThan(merged.spawnMaxWei)) {
    throw new AdminInputError("spawnMinMon cannot exceed spawnMaxMon");
  }
  if (!(merged.spawnMinRadiusM < merged.spawnMaxRadiusM)) {
    throw new AdminInputError(
      "spawnMinRadiusM must be strictly less than spawnMaxRadiusM — spawns are placed in the annulus between them",
    );
  }
  if (merged.startsAt && merged.endsAt && merged.startsAt >= merged.endsAt) {
    throw new AdminInputError("startsAt must be before endsAt");
  }
  if (merged.spawnEnabled && merged.budgetMonWei.lessThanOrEqualTo(0)) {
    throw new AdminInputError(
      "cannot enable spawns with a zero MON budget — set budgetMon first",
    );
  }
  if (merged.autoApproveMaxWei.greaterThan(merged.spawnMaxWei)) {
    throw new AdminInputError(
      "autoApproveMaxMon exceeds spawnMaxMon, which means every spawn auto-approves. Set it below spawnMaxMon, or set it to 0 to require a human on every payout.",
    );
  }
}

export interface CacheWriteInput {
  lat?: number;
  lng?: number;
  radiusMeters?: number;
  rewardCreditWei?: Prisma.Decimal;
  label?: string | null;
  blurb?: string | null;
  photoCid?: string | null;
  active?: boolean;
}

export function parseCacheInput(
  body: Record<string, unknown>,
  mode: "create" | "update",
): CacheWriteInput {
  const out: CacheWriteInput = {};

  if (mode === "create" || body.lat !== undefined) {
    const raw = body.lat;
    const value = typeof raw === "number" ? raw : Number(raw);
    if (!(Number.isFinite(value) && value >= -90 && value <= 90)) {
      throw new AdminInputError("lat must be a number between -90 and 90");
    }
    out.lat = value;
  }
  if (mode === "create" || body.lng !== undefined) {
    const raw = body.lng;
    const value = typeof raw === "number" ? raw : Number(raw);
    if (!(Number.isFinite(value) && value >= -180 && value <= 180)) {
      throw new AdminInputError("lng must be a number between -180 and 180");
    }
    out.lng = value;
  }

  const radiusMeters = optionalInt(body, "radiusMeters", 5, 2000);
  if (radiusMeters !== undefined) out.radiusMeters = radiusMeters;

  const reward = weiField(body, "rewardCreditMon");
  if (reward !== undefined) out.rewardCreditWei = reward;

  const label = optionalString(body, "label", 120);
  if (label !== undefined) out.label = label || null;
  const blurb = optionalString(body, "blurb", 1000);
  if (blurb !== undefined) out.blurb = blurb || null;
  const photoCid = optionalString(body, "photoCid", 200);
  if (photoCid !== undefined) out.photoCid = photoCid || null;

  const active = optionalBool(body, "active");
  if (active !== undefined) out.active = active;

  return out;
}
