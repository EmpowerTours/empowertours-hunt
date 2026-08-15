"use client";

import { bandStyle } from "@/components/radar/bands";
import type { HintBand } from "./types";
import type { HintStatus } from "@/components/hooks/useHint";

/* ---------------------------------------------------------------------------
   The reading, in words.

   The scope carries the feeling; this carries the fact. Note what is NOT here:
   no meters, no "you are 40m away", no arrow. The server never said. Band edges
   are also jittered per player, so even a rough number would be wrong for
   somebody — and a number the player half-trusts is worse than a word they
   read correctly.
--------------------------------------------------------------------------- */

export function BandReadout({
  band,
  complete,
  remaining,
  status,
  error,
}: {
  band: HintBand | null;
  complete: boolean;
  remaining: number;
  status: HintStatus;
  error: string | null;
}) {
  const style = bandStyle(complete ? null : band);
  const label = complete
    ? "ALL FOUND"
    : band === null
      ? "NO READING"
      : style.label;
  const gloss = complete
    ? "Every cache in this hunt is yours. Spawns still drop."
    : status === "throttled"
      ? "Reading paused — too many samples. It will resume on its own."
      : status === "error"
        ? (error ?? "The scope lost the server.")
        : band === null
          ? "Waiting for a fix and a reading."
          : style.gloss;

  return (
    <div
      className="border-hull-line bg-hull rounded-2xl border p-4"
      style={{ borderColor: `${style.color}55` }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div
          className="font-mono text-3xl leading-none font-bold tracking-[0.12em]"
          style={{ color: style.color }}
        >
          {label}
        </div>
        <div className="text-ink-dim shrink-0 font-mono text-xs tracking-[0.16em] uppercase">
          {complete ? "0 left" : `${remaining} left`}
        </div>
      </div>

      <p className="text-ink mt-2 text-sm leading-snug">{gloss}</p>

      {/* The heat ladder, so a player can see where the current reading sits
          without being told a distance. */}
      <div className="mt-3 flex gap-1" aria-hidden>
        {(["cold", "cool", "warm", "hot", "burning"] as const).map((b) => {
          const s = bandStyle(b);
          const active = !complete && band === b;
          const reached = !complete && band !== null && rank(b) <= rank(band);
          return (
            <div
              key={b}
              className="h-1.5 flex-1 rounded-full transition-colors"
              style={{
                backgroundColor: reached ? s.color : "#17343d",
                opacity: active ? 1 : reached ? 0.55 : 1,
              }}
            />
          );
        })}
      </div>

      {/* The scope is a visual instrument; this is the same fact for a screen
          reader, announced only when it changes. */}
      <p className="sr-only" role="status" aria-live="polite">
        {complete
          ? "All caches found."
          : band === null
            ? "No proximity reading."
            : `Proximity ${style.label}. ${remaining} caches left.`}
      </p>
    </div>
  );
}

const ORDER: readonly HintBand[] = ["cold", "cool", "warm", "hot", "burning"];

function rank(band: HintBand): number {
  return ORDER.indexOf(band);
}
