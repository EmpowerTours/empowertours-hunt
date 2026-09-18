"use client";

import { useTranslations } from "next-intl";
import { formatAge } from "./format";
import type { GeoFix, GeoStatus } from "./types";
import { Note } from "@/components/ui/primitives";
import { GEO_FIX_TIMEOUT_MS } from "@/components/hooks/useGeolocation";

// GeoStatus -> "fix" namespace key for the Note title.
const TITLE_KEY = {
  denied: "titleDenied",
  unsupported: "titleUnsupported",
  unavailable: "titleUnavailable",
  timeout: "titleTimeout",
  idle: "titleDefault",
  locating: "titleDefault",
  ready: "titleDefault",
} as const;

/* ---------------------------------------------------------------------------
   GPS honesty panel.

   The verifier refuses any claim whose accuracy exceeds the hunt's
   `maxAccuracyM` (default 30m) and refuses a null accuracy outright. The player
   has no way to know that from a spinner, so this says it plainly BEFORE they
   walk somewhere and tap a button that was always going to fail.
--------------------------------------------------------------------------- */

export type FixQuality = "unknown" | "good" | "marginal" | "too-coarse";

export function fixQuality(
  fix: GeoFix | null,
  maxAccuracyM: number,
): FixQuality {
  if (fix === null) return "unknown";
  // Reject-by-default arithmetic: `!(good)` rather than `if (bad)`, so a NaN
  // accuracy lands on "too coarse" instead of slipping through a comparison.
  if (!(fix.accuracyM <= maxAccuracyM)) return "too-coarse";
  if (!(fix.accuracyM <= maxAccuracyM * 0.6)) return "marginal";
  return "good";
}

const QUALITY_COLOR: Record<FixQuality, string> = {
  unknown: "#47645d",
  good: "#46ffbe",
  marginal: "#ff9d2e",
  "too-coarse": "#ff3b30",
};

/**
 * Seconds left of the device's own deadline, or 0 once it has run out.
 *
 * Counts against `since + GEO_FIX_TIMEOUT_MS`, which is the timeout handed to
 * watchPosition — not a duration this component picked. When it reaches zero
 * the wait is genuinely over-long and the copy says so rather than looping back
 * to twenty and pretending to start again.
 */
export function secondsLeft(
  since: number | null,
  now: number,
  timeoutMs: number,
): number | null {
  if (since === null) return null;
  const remaining = since + timeoutMs - now;
  if (!Number.isFinite(remaining)) return null;
  return Math.max(0, Math.ceil(remaining / 1000));
}

export function FixReadout({
  fix,
  status,
  message,
  maxAccuracyM,
  now,
  since,
  onRetry,
}: {
  fix: GeoFix | null;
  status: GeoStatus;
  message: string | null;
  maxAccuracyM: number;
  now: number;
  /** When the current GPS watch armed. See useGeolocation's `since`. */
  since: number | null;
  onRetry: () => void;
}) {
  const t = useTranslations("fix");
  const tGps = useTranslations("gps");
  const quality = fixQuality(fix, maxAccuracyM);
  const color = QUALITY_COLOR[quality];
  const blocking =
    status === "denied" || status === "unsupported" || status === "unavailable";

  // Only while the player has nothing yet. Once a fix has landed the panel has
  // real numbers to show and a countdown would be noise on top of them.
  const waiting = status === "locating" && fix === null;
  const left = waiting ? secondsLeft(since, now, GEO_FIX_TIMEOUT_MS) : null;

  return (
    <div className="space-y-3">
      <div className="border-hull-line bg-hull flex items-center gap-4 rounded-2xl border p-4">
        <div className="min-w-0 flex-1">
          <div className="text-ink-dim font-mono text-[11px] tracking-[0.18em] uppercase">
            {tGps("accuracy")}
          </div>
          <div className="font-mono text-2xl leading-none" style={{ color }}>
            {fix ? `±${Math.round(fix.accuracyM)} m` : "—"}
          </div>
          <div className="text-ink-faint mt-1 font-mono text-xs">
            {fix
              ? `${formatAge(now - fix.at)} · ${tGps("needs", { meters: maxAccuracyM })}`
              : tGps("needs", { meters: maxAccuracyM })}
          </div>
        </div>

        {/* Accuracy against the threshold, as a bar. Full bar = at the limit. */}
        <div
          className="bg-hull-2 h-14 w-3 overflow-hidden rounded-full"
          aria-hidden
        >
          <div
            className="w-full rounded-full transition-[height]"
            style={{
              height: fix
                ? `${Math.min(100, (fix.accuracyM / maxAccuracyM) * 100)}%`
                : "0%",
              backgroundColor: color,
            }}
          />
        </div>

        {(status === "denied" ||
          status === "timeout" ||
          status === "unavailable") && (
          <button
            type="button"
            onClick={onRetry}
            className="border-hull-line text-ink min-h-14 shrink-0 rounded-xl border-2 px-4 font-mono text-sm tracking-wider uppercase"
          >
            {tGps("retry")}
          </button>
        )}
      </div>

      {/* The wait, named and bounded.

          A player who opens a hunt sees a black scope and a dash where the
          accuracy goes, and nothing on screen says whether that is a phone
          still thinking or an app that has died. Reported from the street once
          already, which is why this panel sits directly under the scope; the
          missing half was how long. The number counts the device's own timeout,
          so at zero the honest thing to say is that it is taking too long —
          not to restart a bar that never meant anything. */}
      {left !== null ? (
        <div
          className="border-hull-line bg-hull rounded-2xl border p-4"
          aria-live="polite"
        >
          <p className="text-ink font-mono text-sm">
            {left > 0
              ? tGps("locatingCountdown", { seconds: left })
              : tGps("locatingSlow")}
          </p>
          <div className="bg-hull-2 mt-3 h-1.5 overflow-hidden rounded-full">
            <div
              className="bg-phosphor h-full rounded-full transition-[width] duration-1000 ease-linear"
              style={{
                width: `${Math.min(100, Math.max(0, 100 - (left / (GEO_FIX_TIMEOUT_MS / 1000)) * 100))}%`,
              }}
            />
          </div>
        </div>
      ) : null}

      {message ? (
        <Note tone={blocking ? "stop" : "warn"} title={t(TITLE_KEY[status])}>
          {message}
        </Note>
      ) : null}

      {message === null && quality === "too-coarse" ? (
        <Note tone="warn" title={t("refusedTitle")}>
          {t("refusedBody", {
            current: Math.round(fix?.accuracyM ?? 0),
            needed: maxAccuracyM,
          })}
        </Note>
      ) : null}
    </div>
  );
}
