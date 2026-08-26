"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useGeoCapability } from "@/components/hooks/useGeoCapability";
import { usePersistentJson } from "@/components/hooks/usePersistentJson";
import {
  appendSample,
  averagePosition,
  fixQuality,
  formatCoordinate,
  MAX_SURVEY_ACCURACY_M,
  type Sample,
} from "@/lib/admin/survey";
import {
  validateRing,
  ringAreaSquareMeters,
  ringPerimeterMeters,
} from "@/lib/admin/zone";
import type { Ring } from "@/lib/geo/polygon";
import {
  Explain,
  Panel,
  Warning,
  Danger,
  Badge,
} from "@/app/admin/_components/ui";

/* ---------------------------------------------------------------------------
   Zone survey — trace the walkable ground by walking it.

   `SurveyField` captures ONE point: stand still, average the noise away, read
   off a coordinate. This captures a RING: walk the outline, drop a corner at
   each turn, and save the shape.

   WHY IT EXISTS: spawns are placed at a random bearing and distance from the
   player, on an abstract disc with no idea what is underneath. Without zones a
   drop lands in the river, inside a house, or on the highway — and then pays
   the player for reaching it. These outlines are what keep placement on
   streets.

   Unlike the cache survey, this one POSTS. Zone shapes are not secret — a zone
   is the public outline of the streets, and the player map needs it — so there
   is no reason to keep the work trapped on one device, and every reason to get
   it into the database while the operator is still standing in the village.

   The draft lives in localStorage between saves because a survey is a walk of
   twenty minutes and a phone browser will happily discard a tab in that time.
--------------------------------------------------------------------------- */

const STORAGE_KEY = "hunt:admin:zonesurvey:v1";

type Kind = "INCLUDE" | "EXCLUDE";

interface Corner {
  lat: number;
  lng: number;
  spreadM: number;
  bestAccuracyM: number;
  samples: number;
}

type GeoStatus =
  | { kind: "idle" }
  | { kind: "watching" }
  | { kind: "unsupported" }
  | { kind: "insecure" }
  | { kind: "error"; message: string };

interface ZoneRow {
  id: string;
  kind: Kind;
  name: string | null;
  vertices: unknown;
  active: boolean;
}

const inputClass =
  "w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-sm text-slate-100";
const btnClass =
  "rounded border border-slate-600 px-3 py-2 text-sm text-slate-100 disabled:opacity-40";

// Module-level so the empty case keeps one identity: `usePersistentJson`
// compares snapshots by reference, and a fresh `[]` per call would never
// settle.
const NO_CORNERS: Corner[] = [];

function reviveCorners(stored: unknown): Corner[] {
  return Array.isArray(stored) ? (stored as Corner[]) : NO_CORNERS;
}

export function ZoneSurvey({
  huntId,
  initialZones,
}: {
  huntId: string;
  initialZones: ZoneRow[];
}) {
  const [status, setStatus] = useState<GeoStatus>({ kind: "idle" });
  const [samples, setSamples] = useState<Sample[]>([]);
  const [reading, setReading] = useState(false);
  // Restored on the FIRST render, not a frame later. A zone survey is a
  // twenty minute walk and a phone browser will discard the tab inside that;
  // showing an empty corner list before the draft loads would read as having
  // lost the walk.
  const [corners, setCorners] = usePersistentJson(STORAGE_KEY, reviveCorners);
  const capability = useGeoCapability();
  const [kind, setKind] = useState<Kind>("INCLUDE");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Server-rendered, so this screen is never briefly wrong about what has
  // already been surveyed. `refreshZones` below is for after a change, and it
  // runs from the handler that made the change — not from an effect.
  const [zones, setZones] = useState<ZoneRow[]>(initialZones);

  const refreshZones = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/hunts/${huntId}/zones`);
      if (!res.ok) return;
      const body = (await res.json()) as { zones?: ZoneRow[] };
      setZones(body.zones ?? []);
    } catch {
      // A failed list is cosmetic; it must not block a survey in progress.
    }
  }, [huntId]);

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
              ? "No position available. Step into the open — under a roof the receiver often has nothing to work with."
              : err.code === err.TIMEOUT
                ? "Timed out waiting for a fix. Still trying."
                : err.message;
        setStatus({ kind: "error", message });
      },
      // maximumAge 0 — a cached fix from the last corner is precisely the thing
      // that would round this outline off at every turn.
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
    );

    return () => {
      navigator.geolocation.clearWatch(id);
    };
  }, [reading]);

  const fix = useMemo(() => averagePosition(samples), [samples]);
  const quality = fixQuality(fix);

  const ring = useMemo<Ring>(
    () => corners.map((c) => ({ lat: c.lat, lng: c.lng })),
    [corners],
  );
  const validation = useMemo(() => validateRing(ring), [ring]);
  const areaM2 = useMemo(() => ringAreaSquareMeters(ring), [ring]);
  const perimeterM = useMemo(() => ringPerimeterMeters(ring), [ring]);

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

  const dropCorner = useCallback(() => {
    if (!fix) return;
    setCorners((prev) => [
      ...prev,
      {
        lat: fix.lat,
        lng: fix.lng,
        spreadM: fix.spreadM,
        bestAccuracyM: fix.bestAccuracyM,
        samples: fix.samples,
      },
    ]);
    // Clear the buffer so the next corner is not averaged with this one — the
    // receiver has to re-settle at the new spot, which is the whole point.
    setSamples([]);
  }, [fix, setCorners]);

  const save = useCallback(async () => {
    if (!validation.ok) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/admin/hunts/${huntId}/zones`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          name: name.trim() || null,
          vertices: ring,
        }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        setSaveError(body.error ?? `save failed (${res.status})`);
        return;
      }
      setCorners([]);
      setName("");
      setSamples([]);
      setReading(false);
      await refreshZones();
    } catch (e) {
      setSaveError(
        e instanceof Error ? e.message : "could not reach the server",
      );
    } finally {
      setSaving(false);
    }
  }, [huntId, kind, name, ring, validation.ok, refreshZones, setCorners]);

  const setZoneActive = useCallback(
    async (zoneId: string, active: boolean) => {
      await fetch(`/api/admin/zones/${zoneId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active }),
      });
      await refreshZones();
    },
    [refreshZones],
  );

  const liveIncludes = zones.filter(
    (z) => z.kind === "INCLUDE" && z.active,
  ).length;

  return (
    <div className="space-y-4">
      <Panel title="Trace the walkable ground">
        <Explain>
          Walk the outline and drop a corner at every turn. Stand still at each
          one until the fix settles, then tap <strong>Drop corner</strong>. The
          shape you save decides where spawns may land — a drop is never placed
          outside it.
        </Explain>

        <Warning>
          Leave a margin. Fixes are accepted down to {MAX_SURVEY_ACCURACY_M}m,
          so trace the hull a few paces INSIDE the safe edge and trace hazards a
          few paces OUTSIDE them. Being generous with the margin costs nothing;
          being exact sends somebody to the riverbank.
        </Warning>

        {status.kind === "insecure" && (
          <Danger>
            Location needs a secure context. Open this over https, not a plain
            http LAN address.
          </Danger>
        )}
        {status.kind === "unsupported" && (
          <Danger>This browser exposes no geolocation.</Danger>
        )}
        {status.kind === "error" && <Danger>{status.message}</Danger>}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={btnClass}
            onClick={start}
            disabled={reading}
          >
            {reading ? "Reading…" : "Start reading"}
          </button>
          <button
            type="button"
            className={btnClass}
            onClick={dropCorner}
            disabled={!fix}
          >
            Drop corner
          </button>
          <button
            type="button"
            className={btnClass}
            onClick={() => setCorners((p) => p.slice(0, -1))}
            disabled={corners.length === 0}
          >
            Undo corner
          </button>
          <button
            type="button"
            className={btnClass}
            onClick={() => {
              setCorners([]);
              setSamples([]);
            }}
            disabled={corners.length === 0}
          >
            Clear
          </button>
          <Badge tone={quality === "good" ? "good" : "warn"}>
            {quality === "waiting"
              ? "waiting for fix"
              : quality === "rough"
                ? "rough fix"
                : "good fix"}
          </Badge>
        </div>

        {fix && (
          <p className="mt-2 font-mono text-xs text-slate-400">
            {formatCoordinate(fix.lat)}, {formatCoordinate(fix.lng)} · spread{" "}
            {fix.spreadM.toFixed(1)}m · best {fix.bestAccuracyM.toFixed(1)}m ·{" "}
            {fix.samples} samples
          </p>
        )}
      </Panel>

      <Panel title={`Outline — ${corners.length} corners`}>
        {corners.length === 0 ? (
          <Explain>
            No corners yet. Start reading, then drop the first one.
          </Explain>
        ) : (
          <>
            <p className="font-mono text-xs text-slate-400">
              {Math.round(perimeterM)}m perimeter ·{" "}
              {areaM2 >= 10_000
                ? `${(areaM2 / 10_000).toFixed(2)} ha`
                : `${Math.round(areaM2)} m²`}
            </p>
            <ol className="mt-2 space-y-1 font-mono text-xs text-slate-400">
              {corners.map((c, i) => (
                <li key={`${c.lat},${c.lng},${i}`}>
                  {i + 1}. {formatCoordinate(c.lat)}, {formatCoordinate(c.lng)}{" "}
                  <span className="text-slate-600">
                    (±{c.bestAccuracyM.toFixed(0)}m)
                  </span>
                </li>
              ))}
            </ol>
          </>
        )}

        {!validation.ok && corners.length > 0 && (
          <Warning>{validation.detail}</Warning>
        )}

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <label className="text-xs text-slate-400">
            Kind
            <select
              className={inputClass}
              value={kind}
              onChange={(e) => setKind(e.target.value as Kind)}
            >
              <option value="INCLUDE">INCLUDE — spawns may land here</option>
              <option value="EXCLUDE">EXCLUDE — never place here</option>
            </select>
          </label>
          <label className="text-xs text-slate-400">
            Name
            <input
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="plaza / the river / the highway"
            />
          </label>
        </div>

        {saveError && <Danger>{saveError}</Danger>}

        <button
          type="button"
          className={`${btnClass} mt-3`}
          onClick={save}
          disabled={!validation.ok || saving}
        >
          {saving ? "Saving…" : `Save ${kind.toLowerCase()} zone`}
        </button>
      </Panel>

      <Panel title="Zones on this hunt">
        {liveIncludes === 0 && (
          <Danger>
            No active INCLUDE zone, so this hunt places no spawns at all. That
            is the safe direction, not a bug — but nothing will drop until one
            exists.
          </Danger>
        )}
        {zones.length === 0 ? (
          <Explain>Nothing surveyed yet.</Explain>
        ) : (
          <ul className="space-y-1 text-sm">
            {zones.map((z) => (
              <li key={z.id} className="flex items-center gap-2">
                <Badge tone={z.kind === "INCLUDE" ? "good" : "warn"}>
                  {z.kind}
                </Badge>
                <span className="text-slate-200">{z.name ?? "unnamed"}</span>
                <span className="font-mono text-xs text-slate-500">
                  {Array.isArray(z.vertices) ? z.vertices.length : 0} corners
                </span>
                {!z.active && (
                  <span className="text-xs text-slate-500">retired</span>
                )}
                <button
                  type="button"
                  className="ml-auto rounded border border-slate-700 px-2 py-1 text-xs text-slate-300"
                  onClick={() => void setZoneActive(z.id, !z.active)}
                >
                  {z.active ? "Retire" : "Restore"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
