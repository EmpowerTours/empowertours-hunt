"use client";

import { useTranslations } from "next-intl";
import { SPAWN_REJECT_REASONS } from "@/lib/hunt/spawn";

/**
 * Translate a spawn refusal for the player.
 *
 * Replaces the English-only `spawnReasonCopy`. The reason strings themselves
 * stay exactly as the server sends them — they are stored in ClaimAttempt.reason
 * and read back during a payout dispute, so they are DATA and must never be
 * localised. Only what the player reads changes.
 *
 * An unrecognised reason falls back to a generic refusal rather than rendering
 * the raw key. A route that grows a new reason then says something plain
 * instead of showing `spawnReason.some_new_thing` to somebody in a street.
 */
export function useSpawnReason(): (reason: string | null) => string {
  const t = useTranslations("spawnReason");

  return (reason) => {
    if (!reason) return t("unknown");
    const known = (SPAWN_REJECT_REASONS as readonly string[]).includes(reason);
    // "no_walkable_ground" and "contended" live in SPAWN_DENY_REASONS rather
    // than SPAWN_REJECT_REASONS, so both lists are consulted via the catalogue
    // itself: if the key exists we use it, otherwise the generic line.
    return known || t.has(reason) ? t(reason) : t("unknown");
  };
}
