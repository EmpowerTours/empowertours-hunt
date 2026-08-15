"use client";

import { Note } from "@/components/ui/primitives";
import { formatCountdown, formatMeters, formatMon, weiOrZero } from "./format";
import { spawnReasonCopy } from "./copy";
import { compassPoint } from "./geo";
import type { SpawnMark } from "@/components/radar/RadarScope";

/* ---------------------------------------------------------------------------
   Spawns, in list form.

   The deliberate opposite of the cache readout in every respect: a spawn has a
   real bearing, a real distance and a real amount, and all three are shown
   exactly. Coordinates are public by design (see the Spawn model in
   prisma/schema.prisma) — the defence is a short TTL and movement
   plausibility, not secrecy — so there is nothing to blur.

   Collect is the only player-reachable path that ends in native MON leaving
   the treasury, so the button appears only once the player is inside the
   spawn's own radius, it requires a signature, and the server still decides.
--------------------------------------------------------------------------- */

export function SpawnPanel({
  marks,
  now,
  selectedId,
  onSelect,
  onCollect,
  collectingId,
  scanReason,
  stopped,
  error,
  signingAvailable,
}: {
  marks: readonly SpawnMark[];
  now: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCollect: (id: string) => void;
  collectingId: string | null;
  /** Why the last scan produced no new drop, if it did not. */
  scanReason: string | null;
  /** Scanning has stopped for a reason that will not change by waiting. */
  stopped: boolean;
  error: string | null;
  signingAvailable: boolean;
}) {
  const live = marks.filter(
    (m) => new Date(m.spawn.expiresAt).getTime() - now > 0,
  );

  return (
    <div className="space-y-2">
      <div className="text-ink-dim px-1 font-mono text-[11px] tracking-[0.18em] uppercase">
        {live.length === 0
          ? "Spawns · real MON"
          : `${live.length} spawn${live.length === 1 ? "" : "s"} · real MON`}
      </div>

      {error ? (
        <Note tone="warn" title="Spawn feed">
          {error}
        </Note>
      ) : null}

      {live.length === 0 ? (
        <div className="border-hull-line bg-hull rounded-2xl border p-4">
          <p className="text-ink-faint text-sm leading-snug">
            {stopped && scanReason
              ? spawnReasonCopy(scanReason)
              : scanReason
                ? spawnReasonCopy(scanReason)
                : "Nothing on the scope. Drops appear near you at random and expire fast."}
          </p>
        </div>
      ) : null}

      <ul className="space-y-2">
        {live.map((mark) => {
          const msLeft = new Date(mark.spawn.expiresAt).getTime() - now;
          const expiring = msLeft < 60_000;
          const selected = selectedId === mark.spawn.id;
          const collecting = collectingId === mark.spawn.id;
          const stillToWalk = Math.max(
            mark.distanceMeters - mark.spawn.radiusMeters,
            0,
          );

          return (
            <li key={mark.spawn.id}>
              <div
                className={`bg-hull rounded-2xl border p-3 ${
                  selected ? "border-spawn/70" : "border-hull-line"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelect(mark.spawn.id)}
                  className="flex min-h-14 w-full items-center gap-3 text-left"
                >
                  <span
                    className="border-spawn/60 text-spawn flex size-11 shrink-0 items-center justify-center rounded-full border-2 font-mono text-xs"
                    aria-hidden
                  >
                    {compassPoint(mark.bearingDeg)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-spawn block font-mono text-lg leading-none">
                      {formatMon(weiOrZero(mark.spawn.amountMonWei))} MON
                    </span>
                    <span className="text-ink-dim mt-1 block font-mono text-xs">
                      {formatMeters(mark.distanceMeters)} ·{" "}
                      {Math.round(mark.bearingDeg)}°
                    </span>
                  </span>
                  <span
                    className={`shrink-0 font-mono text-lg ${
                      expiring ? "text-alert" : "text-ink-dim"
                    }`}
                  >
                    {formatCountdown(msLeft)}
                  </span>
                </button>

                {mark.inReach ? (
                  <>
                    <button
                      type="button"
                      onClick={() => onCollect(mark.spawn.id)}
                      disabled={collecting || !signingAvailable}
                      className="bg-spawn text-void mt-3 min-h-14 w-full rounded-xl text-lg font-semibold tracking-wide disabled:opacity-50"
                    >
                      {collecting ? "COLLECTING…" : "COLLECT"}
                    </button>
                    {!signingAvailable ? (
                      <p className="text-ink-faint mt-2 text-xs leading-snug">
                        Collecting MON requires a signature. The passkey signer
                        is not registered in this build.
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="text-ink-faint mt-2 font-mono text-xs">
                    Walk {formatMeters(stillToWalk)} closer to collect
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
