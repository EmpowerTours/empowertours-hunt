"use client";

import { formatAge } from "./format";
import type { GeoFix, GeoStatus } from "./types";
import { Note } from "@/components/ui/primitives";

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

export function FixReadout({
  fix,
  status,
  message,
  maxAccuracyM,
  now,
  onRetry,
}: {
  fix: GeoFix | null;
  status: GeoStatus;
  message: string | null;
  maxAccuracyM: number;
  now: number;
  onRetry: () => void;
}) {
  const quality = fixQuality(fix, maxAccuracyM);
  const color = QUALITY_COLOR[quality];
  const blocking =
    status === "denied" || status === "unsupported" || status === "unavailable";

  return (
    <div className="space-y-3">
      <div className="border-hull-line bg-hull flex items-center gap-4 rounded-2xl border p-4">
        <div className="min-w-0 flex-1">
          <div className="text-ink-dim font-mono text-[11px] tracking-[0.18em] uppercase">
            GPS accuracy
          </div>
          <div className="font-mono text-2xl leading-none" style={{ color }}>
            {fix ? `±${Math.round(fix.accuracyM)} m` : "—"}
          </div>
          <div className="text-ink-faint mt-1 font-mono text-xs">
            {fix
              ? `${formatAge(now - fix.at)} · needs ±${maxAccuracyM} m`
              : `needs ±${maxAccuracyM} m`}
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
            Retry
          </button>
        )}
      </div>

      {message ? (
        <Note tone={blocking ? "stop" : "warn"} title={geoTitle(status)}>
          {message}
        </Note>
      ) : null}

      {message === null && quality === "too-coarse" ? (
        <Note tone="warn" title="Claim will be refused">
          Your phone is only sure to ±{Math.round(fix?.accuracyM ?? 0)} m and
          this hunt needs ±{maxAccuracyM} m. Step into open sky and wait — the
          server rejects a claim on this fix, so tapping now only burns a rate
          limit.
        </Note>
      ) : null}
    </div>
  );
}

function geoTitle(status: GeoStatus): string {
  switch (status) {
    case "denied":
      return "Location blocked";
    case "unsupported":
      return "No geolocation";
    case "unavailable":
      return "No fix";
    case "timeout":
      return "Fix stale";
    default:
      return "Location";
  }
}
