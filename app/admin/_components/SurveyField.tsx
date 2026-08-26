"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useGeoCapability } from "@/components/hooks/useGeoCapability";
import { usePersistentJson } from "@/components/hooks/usePersistentJson";
import {
  appendSample,
  averagePosition,
  fixQuality,
  formatCoordinate,
  toCacheDraft,
  GOOD_SPREAD_M,
  MAX_SURVEY_ACCURACY_M,
  MIN_SAMPLES_FOR_FIX,
  MOVED_AWAY_M,
  type Sample,
} from "@/lib/admin/survey";
import { Explain, Panel, Warning } from "@/app/admin/_components/ui";

/* ---------------------------------------------------------------------------
   Field survey.

   `CacheManager` takes lat/lng as typed text; this is where those digits come
   from. Stand on the spot, wait for the receiver to settle, capture, then paste
   the pair into the cache form.

   Everything stays on this device. Nothing is posted, so a survey in progress
   is not a cache coordinate sitting in a server log — but it IS a cache
   coordinate sitting in this browser's storage, which is why "forget all" is a
   first-class control rather than a footnote.
--------------------------------------------------------------------------- */

const STORAGE_KEY = "hunt:admin:survey:v1";

interface Capture {
  id: string;
  label: string;
  lat: number;
  lng: number;
  radiusMeters: number;
  samples: number;
  spreadM: number;
  bestAccuracyM: number;
  surveyedAt: string;
}

type GeoStatus =
  | { kind: "idle" }
  | { kind: "watching" }
  | { kind: "unsupported" }
  | { kind: "insecure" }
  | { kind: "error"; message: string };

const inputClass =
  "w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-sm text-slate-100";

// Module-level so the empty case keeps one identity: `usePersistentJson`
// compares snapshots by reference, and a fresh `[]` per call would never
// settle.
const NO_CAPTURES: Capture[] = [];

function reviveCaptures(stored: unknown): Capture[] {
  return Array.isArray(stored) ? (stored as Capture[]) : NO_CAPTURES;
}

export function SurveyField() {
  const [status, setStatus] = useState<GeoStatus>({ kind: "idle" });
  const [samples, setSamples] = useState<Sample[]>([]);
  const [reading, setReading] = useState(false);
  const [captures, setCaptures] = usePersistentJson(
    STORAGE_KEY,
    reviveCaptures,
  );
  const capability = useGeoCapability();
  const [label, setLabel] = useState("");
  const [radius, setRadius] = useState("25");
  const [copied, setCopied] = useState<string | null>(null);

  // Nothing to check here any more: `start` refuses before it ever sets
  // `reading`, so by the time this runs the receiver is known to be usable.
  useEffect(() => {
    if (!reading) return;

    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setStatus({ kind: "watching" });
        setSamples((prev) =>
          appendSample(prev, {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracyM: pos.coords.accuracy,
            at: pos.timestamp,
          }),
        );
      },
      (err) => {
        const message =
          err.code === err.PERMISSION_DENIED
            ? "Location permission denied. Allow it for this site in the browser settings."
            : err.code === err.POSITION_UNAVAILABLE
              ? "No position available. Step outside — indoors the receiver often has nothing to work with."
              : err.code === err.TIMEOUT
                ? "Timed out waiting for a fix. Still trying."
                : err.message;
        setStatus({ kind: "error", message });
      },
      // maximumAge 0: a cached fix from wherever this phone was ten minutes ago
      // is exactly what a survey must never record.
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
    );

    return () => {
      navigator.geolocation.clearWatch(id);
    };
  }, [reading]);

  const fix = useMemo(() => averagePosition(samples), [samples]);
  const quality = fixQuality(fix);
  const latest = samples.length > 0 ? samples[samples.length - 1] : null;
  const radiusNum = Number(radius);
  const radiusValid = Number.isFinite(radiusNum) && radiusNum > 0;

  // Refuses at the button rather than arming a watch that cannot fire. On a
  // plain-http LAN address — the usual way this screen looks broken — the
  // reason is now on screen the moment it is asked for.
  const start = useCallback(() => {
    if (capability === "unsupported" || capability === "insecure") {
      setStatus({ kind: capability });
      return;
    }
    setSamples([]);
    setStatus({ kind: "watching" });
    setReading(true);
  }, [capability]);

  const capture = useCallback(() => {
    if (!fix || !radiusValid) return;
    const entry: Capture = {
      id: `${fix.lat.toFixed(6)},${fix.lng.toFixed(6)}`,
      label: label.trim() || "unlabelled",
      lat: fix.lat,
      lng: fix.lng,
      radiusMeters: radiusNum,
      samples: fix.samples,
      spreadM: fix.spreadM,
      bestAccuracyM: fix.bestAccuracyM,
      surveyedAt: new Date().toISOString(),
    };
    setCaptures((prev) => [entry, ...prev.filter((c) => c.id !== entry.id)]);
    setLabel("");
    setSamples([]);
    setReading(false);
  }, [fix, label, radiusNum, radiusValid, setCaptures]);

  const copy = useCallback(async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied("clipboard blocked — select the value and copy it by hand");
      window.setTimeout(() => setCopied(null), 4000);
    }
  }, []);

  const verdict =
    quality === "waiting"
      ? `Waiting for ${MIN_SAMPLES_FOR_FIX} usable fixes. Keep still.`
      : quality === "rough"
        ? `Fixes disagree by more than ${GOOD_SPREAD_M}m. Wait, or move clear of walls and tree cover.`
        : "Settled. Good enough to capture.";

  const verdictClass =
    quality === "good" ? "text-emerald-300" : "text-amber-300";

  return (
    <div className="flex flex-col gap-3">
      <Panel
        title="Reading"
        subtitle="Stand where the cache goes. Wait for the fixes to agree, then capture."
      >
        {!reading ? (
          <button
            type="button"
            onClick={start}
            className="rounded bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-900"
          >
            Start reading here
          </button>
        ) : (
          <div className="flex flex-col gap-3">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Readout k="lat" v={fix ? formatCoordinate(fix.lat) : "—"} />
              <Readout k="lng" v={fix ? formatCoordinate(fix.lng) : "—"} />
              <Readout
                k="fixes"
                v={`${fix?.samples ?? 0} / ${MIN_SAMPLES_FOR_FIX}`}
              />
              <Readout
                k="spread"
                v={fix ? `${Math.round(fix.spreadM)}m` : "—"}
              />
              <Readout
                k="best"
                v={fix ? `${Math.round(fix.bestAccuracyM)}m` : "—"}
              />
              <Readout
                k="last"
                v={latest ? `${Math.round(latest.accuracyM)}m` : "—"}
              />
            </dl>

            <p className={`text-xs font-semibold ${verdictClass}`}>{verdict}</p>

            <button
              type="button"
              onClick={() => setReading(false)}
              className="self-start rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-400"
            >
              Stop
            </button>
          </div>
        )}

        {status.kind === "error" && (
          <div className="mt-3">
            <Warning>{status.message}</Warning>
          </div>
        )}
        {status.kind === "unsupported" && (
          <div className="mt-3">
            <Warning>This browser has no geolocation.</Warning>
          </div>
        )}
        {status.kind === "insecure" && (
          <div className="mt-3">
            <Warning>
              Location needs https. Open this page on the deployed host, not
              over a plain http LAN address.
            </Warning>
          </div>
        )}

        <Explain>
          Fixes looser than {MAX_SURVEY_ACCURACY_M}m are ignored, and the mean
          weights each by 1/accuracy² so a 5m fix outweighs a 50m one a hundred
          to one. Walking more than {MOVED_AWAY_M}m mid-reading starts the count
          over — averaging two corners produces a confident coordinate for a
          spot that is neither. Spread is reported instead of an error bar
          because fixes from one receiver share the same bias and do not average
          out; a tight spread means the receiver settled, not that it is right.
        </Explain>
      </Panel>

      <Panel title="Capture">
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-[10rem] flex-1">
            <span className="text-[10px] uppercase tracking-wider text-slate-500">
              label (this device only)
            </span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="behind the church"
              maxLength={60}
              className={inputClass}
            />
          </label>
          <label className="w-28">
            <span className="text-[10px] uppercase tracking-wider text-slate-500">
              radius (m)
            </span>
            <input
              value={radius}
              onChange={(e) => setRadius(e.target.value)}
              inputMode="numeric"
              className={inputClass}
            />
          </label>
          <button
            type="button"
            onClick={capture}
            disabled={quality === "waiting" || !radiusValid}
            className="rounded bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-900 disabled:opacity-50"
          >
            {quality === "waiting" ? "No fix yet" : "Capture"}
          </button>
        </div>
        {!radiusValid && (
          <Explain>Radius must be a positive number of metres.</Explain>
        )}
      </Panel>

      <Panel
        title={`Captured (${captures.length})`}
        subtitle="Paste these into the cache form on the hunt's page."
        actions={
          captures.length > 0 ? (
            <button
              type="button"
              onClick={() => setCaptures([])}
              className="rounded border border-red-700 px-2 py-1 text-[11px] text-red-300"
            >
              Forget all
            </button>
          ) : undefined
        }
      >
        {captures.length === 0 ? (
          <p className="text-xs text-slate-600">Nothing captured yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {captures.map((c) => {
              const draft = toCacheDraft(c, c.radiusMeters);
              return (
                <li
                  key={c.id}
                  className="rounded border border-slate-800 bg-slate-950/60 p-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-200">
                      {c.label}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setCaptures((p) => p.filter((x) => x.id !== c.id))
                      }
                      className="text-[11px] text-slate-500"
                    >
                      remove
                    </button>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-2">
                    <CopyField
                      k="lat"
                      v={draft.lat}
                      onCopy={() => copy(draft.lat, "lat")}
                    />
                    <CopyField
                      k="lng"
                      v={draft.lng}
                      onCopy={() => copy(draft.lng, "lng")}
                    />
                    <CopyField
                      k="radius"
                      v={draft.radiusMeters}
                      onCopy={() => copy(draft.radiusMeters, "radius")}
                    />
                  </div>
                  <p className="mt-1 font-mono text-[10px] text-slate-600">
                    {c.samples} fixes · {Math.round(c.spreadM)}m spread · best{" "}
                    {Math.round(c.bestAccuracyM)}m · {c.surveyedAt.slice(0, 10)}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
        {copied && <Explain>Copied {copied}.</Explain>}
        <Explain>
          These coordinates are cache locations and they persist in this
          browser. Use “forget all” when the survey is done, and do not run this
          on a shared device.
        </Explain>
      </Panel>
    </div>
  );
}

function Readout({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-slate-500">
        {k}
      </dt>
      <dd className="font-mono text-lg tabular-nums text-slate-100">{v}</dd>
    </div>
  );
}

function CopyField({
  k,
  v,
  onCopy,
}: {
  k: string;
  v: string;
  onCopy: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onCopy}
      className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-left hover:border-slate-500"
    >
      <span className="block text-[10px] uppercase tracking-wider text-slate-500">
        {k}
      </span>
      <span className="block font-mono text-xs tabular-nums text-slate-100">
        {v}
      </span>
    </button>
  );
}
