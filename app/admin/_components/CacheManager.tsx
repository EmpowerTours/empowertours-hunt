"use client";

// Cache management — the ONE screen where cache coordinates are visible.
//
// They live here and nowhere else. No player-reachable response includes a
// cache lat/lng, not in a body, not in an error, not in a hint payload. The
// page hosting this component is OPERATOR-gated and every edit made here
// writes an append-only AdminAction row including the coordinates.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { adminPost } from "@/app/admin/_components/api";

export interface CacheRow {
  id: string;
  lat: number;
  lng: number;
  radiusMeters: number;
  rewardCreditMon: string;
  label: string | null;
  blurb: string | null;
  photoCid: string | null;
  active: boolean;
  finds: number;
  createdAt: string;
}

const inputClass =
  "w-full rounded border border-slate-700 bg-slate-950 px-1.5 py-1 font-mono text-[11px] text-slate-100";

export function CacheManager({
  huntId,
  caches,
}: {
  huntId: string;
  caches: CacheRow[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({
    lat: "",
    lng: "",
    radiusMeters: "25",
    rewardCreditMon: "0",
    label: "",
    blurb: "",
  });

  async function create() {
    setBusy("new");
    setError(null);
    const res = await adminPost(`/api/admin/hunts/${huntId}/caches`, {
      lat: draft.lat,
      lng: draft.lng,
      radiusMeters: Number(draft.radiusMeters),
      rewardCreditMon: draft.rewardCreditMon,
      label: draft.label,
      blurb: draft.blurb,
    });
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setCreating(false);
    setDraft({
      lat: "",
      lng: "",
      radiusMeters: "25",
      rewardCreditMon: "0",
      label: "",
      blurb: "",
    });
    router.refresh();
  }

  return (
    <div>
      {error && (
        <div className="mb-2 rounded border border-red-700 bg-red-950/60 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}

      <div className="mb-3">
        {!creating ? (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded border border-slate-600 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800"
          >
            Add a cache
          </button>
        ) : (
          <div className="rounded border border-slate-700 bg-slate-900/60 p-3">
            <div className="grid gap-2 md:grid-cols-3 lg:grid-cols-6">
              <label className="text-[10px] uppercase tracking-wider text-slate-500">
                lat
                <input
                  className={inputClass}
                  value={draft.lat}
                  placeholder="20.67222"
                  onChange={(e) => setDraft({ ...draft, lat: e.target.value })}
                />
              </label>
              <label className="text-[10px] uppercase tracking-wider text-slate-500">
                lng
                <input
                  className={inputClass}
                  value={draft.lng}
                  placeholder="-103.34778"
                  onChange={(e) => setDraft({ ...draft, lng: e.target.value })}
                />
              </label>
              <label className="text-[10px] uppercase tracking-wider text-slate-500">
                radius (m)
                <input
                  className={inputClass}
                  value={draft.radiusMeters}
                  onChange={(e) =>
                    setDraft({ ...draft, radiusMeters: e.target.value })
                  }
                />
              </label>
              <label className="text-[10px] uppercase tracking-wider text-slate-500">
                reward (WMON)
                <input
                  className={inputClass}
                  value={draft.rewardCreditMon}
                  onChange={(e) =>
                    setDraft({ ...draft, rewardCreditMon: e.target.value })
                  }
                />
              </label>
              <label className="text-[10px] uppercase tracking-wider text-slate-500">
                label
                <input
                  className={inputClass}
                  value={draft.label}
                  onChange={(e) =>
                    setDraft({ ...draft, label: e.target.value })
                  }
                />
              </label>
              <label className="text-[10px] uppercase tracking-wider text-slate-500">
                blurb
                <input
                  className={inputClass}
                  value={draft.blurb}
                  onChange={(e) =>
                    setDraft({ ...draft, blurb: e.target.value })
                  }
                />
              </label>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              Label and blurb are revealed to the player only AFTER they find
              it. The reward is TURBO credit in WMON-wei, not withdrawable MON;
              it is snapshotted onto each Find, so editing it later never
              changes what a past find was worth.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={create}
                disabled={busy === "new"}
                className="rounded bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-900 disabled:opacity-50"
              >
                {busy === "new" ? "…" : "Create cache"}
              </button>
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="rounded border border-slate-700 px-3 py-1 text-xs text-slate-400"
              >
                cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              {[
                "Coordinates",
                "Radius",
                "Reward (WMON)",
                "Label",
                "Finds",
                "State",
                "",
              ].map((h) => (
                <th
                  key={h}
                  className="border-b border-slate-800 px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-500"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {caches.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-2 py-6 text-center text-slate-600"
                >
                  No caches in this hunt yet.
                </td>
              </tr>
            )}
            {caches.map((c) => (
              <CacheEditRow
                key={c.id}
                cache={c}
                busy={busy}
                setBusy={setBusy}
                setError={setError}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CacheEditRow({
  cache,
  busy,
  setBusy,
  setError,
}: {
  cache: CacheRow;
  busy: string | null;
  setBusy: (v: string | null) => void;
  setError: (v: string | null) => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState({
    lat: String(cache.lat),
    lng: String(cache.lng),
    radiusMeters: String(cache.radiusMeters),
    rewardCreditMon: cache.rewardCreditMon,
    label: cache.label ?? "",
    blurb: cache.blurb ?? "",
    active: cache.active,
  });

  async function save() {
    setBusy(cache.id);
    setError(null);
    const res = await adminPost(
      `/api/admin/caches/${cache.id}`,
      {
        lat: v.lat,
        lng: v.lng,
        radiusMeters: Number(v.radiusMeters),
        rewardCreditMon: v.rewardCreditMon,
        label: v.label,
        blurb: v.blurb,
        active: v.active,
      },
      "PATCH",
    );
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setEditing(false);
    router.refresh();
  }

  async function retire() {
    setBusy(cache.id);
    setError(null);
    const res = await adminPost(
      `/api/admin/caches/${cache.id}`,
      undefined,
      "DELETE",
    );
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  if (!editing) {
    return (
      <tr className={cache.active ? undefined : "opacity-50"}>
        <td className="border-b border-slate-900 px-2 py-1.5 font-mono tabular-nums text-slate-300">
          {cache.lat.toFixed(6)}, {cache.lng.toFixed(6)}
        </td>
        <td className="border-b border-slate-900 px-2 py-1.5 font-mono tabular-nums text-slate-300">
          {cache.radiusMeters} m
        </td>
        <td className="border-b border-slate-900 px-2 py-1.5 font-mono tabular-nums text-slate-300">
          {cache.rewardCreditMon}
        </td>
        <td className="border-b border-slate-900 px-2 py-1.5 text-slate-300">
          {cache.label ?? "—"}
        </td>
        <td className="border-b border-slate-900 px-2 py-1.5 font-mono tabular-nums text-slate-300">
          {cache.finds}
        </td>
        <td className="border-b border-slate-900 px-2 py-1.5">
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] uppercase ${
              cache.active
                ? "border-emerald-800 bg-emerald-950 text-emerald-300"
                : "border-slate-700 bg-slate-800 text-slate-400"
            }`}
          >
            {cache.active ? "active" : "retired"}
          </span>
        </td>
        <td className="border-b border-slate-900 px-2 py-1.5">
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800"
            >
              edit
            </button>
            {cache.active && (
              <button
                type="button"
                onClick={retire}
                disabled={busy === cache.id}
                className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-400 hover:bg-slate-800 disabled:opacity-40"
                title="Retires the cache. Rows are never deleted — existing finds and the credit they issued stay intact."
              >
                retire
              </button>
            )}
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr className="bg-slate-900/60">
      <td className="border-b border-slate-900 px-2 py-1.5">
        <div className="flex gap-1">
          <input
            className={inputClass}
            value={v.lat}
            onChange={(e) => setV({ ...v, lat: e.target.value })}
          />
          <input
            className={inputClass}
            value={v.lng}
            onChange={(e) => setV({ ...v, lng: e.target.value })}
          />
        </div>
      </td>
      <td className="border-b border-slate-900 px-2 py-1.5">
        <input
          className={inputClass}
          value={v.radiusMeters}
          onChange={(e) => setV({ ...v, radiusMeters: e.target.value })}
        />
      </td>
      <td className="border-b border-slate-900 px-2 py-1.5">
        <input
          className={inputClass}
          value={v.rewardCreditMon}
          onChange={(e) => setV({ ...v, rewardCreditMon: e.target.value })}
        />
      </td>
      <td className="border-b border-slate-900 px-2 py-1.5">
        <input
          className={inputClass}
          value={v.label}
          onChange={(e) => setV({ ...v, label: e.target.value })}
        />
      </td>
      <td className="border-b border-slate-900 px-2 py-1.5 font-mono text-slate-500">
        {cache.finds}
      </td>
      <td className="border-b border-slate-900 px-2 py-1.5">
        <select
          className={inputClass}
          value={String(v.active)}
          onChange={(e) => setV({ ...v, active: e.target.value === "true" })}
        >
          <option value="true">active</option>
          <option value="false">retired</option>
        </select>
      </td>
      <td className="border-b border-slate-900 px-2 py-1.5">
        <div className="flex gap-1">
          <button
            type="button"
            onClick={save}
            disabled={busy === cache.id}
            className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-900 disabled:opacity-50"
          >
            save
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-400"
          >
            cancel
          </button>
        </div>
      </td>
    </tr>
  );
}
