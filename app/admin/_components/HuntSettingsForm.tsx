"use client";

// Hunt configuration.
//
// Every control on this form loosens or tightens something that costs money or
// bounds fraud, so every one carries an explanation of what loosening it buys
// and what it costs. An operator who does not know that maxSpeedKmh is the
// teleport check will eventually raise it to "fix" a support ticket.
//
// MON amounts are typed in MON, not wei, and are parsed server-side by
// `parseMonInput`, which rejects "1e18", "0x10", blanks and negatives. The
// form does not attempt its own wei conversion — one parser, server-side, is
// the whole point.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { adminPost } from "@/app/admin/_components/api";

export interface HuntFormValues {
  name: string;
  description: string;
  active: boolean;
  startsAt: string;
  endsAt: string;
  maxAccuracyM: number;
  maxSpeedKmh: number;
  cooldownSeconds: number;
  maxClockSkewSeconds: number;
  budgetCreditMon: string;
  maxFindsPerPlayer: number;
  spawnEnabled: boolean;
  budgetMon: string;
  spawnMinMon: string;
  spawnMaxMon: string;
  spawnMinRadiusM: number;
  spawnMaxRadiusM: number;
  spawnTtlSeconds: number;
  spawnCooldownSeconds: number;
  spawnDailyCapMonPerPlayer: string;
  autoApproveMaxMon: string;
  autoApproveDailyCapMon: string;
}

function Field({
  label,
  explain,
  children,
}: {
  label: string;
  explain: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        {label}
      </span>
      <div className="mt-1">{children}</div>
      <span className="mt-1 block text-[11px] leading-relaxed text-slate-500">
        {explain}
      </span>
    </label>
  );
}

const inputClass =
  "w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-xs text-slate-100";

export function HuntSettingsForm({
  huntId,
  initial,
}: {
  huntId: string;
  initial: HuntFormValues;
}) {
  const router = useRouter();
  const [v, setV] = useState<HuntFormValues>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changes, setChanges] = useState<string[] | null>(null);

  function set<K extends keyof HuntFormValues>(k: K, value: HuntFormValues[K]) {
    setV((prev) => ({ ...prev, [k]: value }));
  }

  async function save() {
    setBusy(true);
    setError(null);
    setChanges(null);
    const res = await adminPost<{ changes?: string[] }>(
      `/api/admin/hunts/${huntId}`,
      v,
      "PATCH",
    );
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setChanges(res.data.changes ?? []);
    router.refresh();
  }

  const autoApproveOff =
    v.autoApproveMaxMon.trim() === "" || Number(v.autoApproveMaxMon) === 0;

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="rounded border border-red-700 bg-red-950/60 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}
      {changes && (
        <div className="rounded border border-emerald-800 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-200">
          {changes.length === 0
            ? "No change."
            : `Saved and logged: ${changes.join("; ")}`}
        </div>
      )}

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-300">
          Identity and window
        </h3>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Name" explain="Shown to players.">
            <input
              className={inputClass}
              value={v.name}
              onChange={(e) => set("name", e.target.value)}
            />
          </Field>
          <Field
            label="Active"
            explain="Inactive hunts reject every claim before any positional work happens. This is the fastest way to stop a hunt that is going wrong."
          >
            <select
              className={inputClass}
              value={String(v.active)}
              onChange={(e) => set("active", e.target.value === "true")}
            >
              <option value="false">inactive</option>
              <option value="true">active</option>
            </select>
          </Field>
          <Field
            label="Starts at"
            explain="ISO datetime, or blank for no start bound."
          >
            <input
              className={inputClass}
              value={v.startsAt}
              placeholder="2026-08-20T09:00:00.000Z"
              onChange={(e) => set("startsAt", e.target.value)}
            />
          </Field>
          <Field
            label="Ends at"
            explain="ISO datetime, or blank for no end bound."
          >
            <input
              className={inputClass}
              value={v.endsAt}
              placeholder="2026-09-20T09:00:00.000Z"
              onChange={(e) => set("endsAt", e.target.value)}
            />
          </Field>
          <div className="md:col-span-2">
            <Field label="Description" explain="Optional blurb.">
              <textarea
                className={inputClass}
                rows={2}
                value={v.description}
                onChange={(e) => set("description", e.target.value)}
              />
            </Field>
          </div>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-300">
          Verifier rules
        </h3>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <Field
            label="Max GPS accuracy (m)"
            explain="Claims whose reported accuracy is worse than this are rejected. Raising it accepts vaguer fixes — which is also what a spoofed fix looks like when it is trying to stay plausible. Lowering it turns away honest players indoors and under tree cover."
          >
            <input
              type="number"
              className={inputClass}
              value={v.maxAccuracyM}
              onChange={(e) => set("maxAccuracyM", Number(e.target.value))}
            />
          </Field>
          <Field
            label="Max speed (km/h)"
            explain="The teleport check: distance from the last verified position over elapsed time. This is the single most load-bearing anti-spoofing number here. 60 km/h already permits a car. Raising it towards aircraft speed effectively turns the check off."
          >
            <input
              type="number"
              className={inputClass}
              value={v.maxSpeedKmh}
              onChange={(e) => set("maxSpeedKmh", Number(e.target.value))}
            />
          </Field>
          <Field
            label="Cooldown (s)"
            explain="Minimum gap between claim attempts from one player. Bounds how fast an automated client can sweep, and how fast a probe can walk a hint boundary."
          >
            <input
              type="number"
              className={inputClass}
              value={v.cooldownSeconds}
              onChange={(e) => set("cooldownSeconds", Number(e.target.value))}
            />
          </Field>
          <Field
            label="Max clock skew (s)"
            explain="How far a player's signed timestamp may differ from the server's. Also the TTL on the single-use signature nonce, so widening it widens the replay window."
          >
            <input
              type="number"
              className={inputClass}
              value={v.maxClockSkewSeconds}
              onChange={(e) =>
                set("maxClockSkewSeconds", Number(e.target.value))
              }
            />
          </Field>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-300">
          Credit budget (cache finds — TURBO credit, not cash)
        </h3>
        <div className="grid gap-3 md:grid-cols-2">
          <Field
            label="Credit budget (WMON)"
            explain="Ceiling on all TURBO credit this hunt may ever issue. Enforced by an atomic conditional UPDATE at claim time, so it cannot be overspent by concurrent claims. Credit is a subscription discount, not withdrawable cash — it costs margin only when someone actually joins."
          >
            <input
              className={inputClass}
              value={v.budgetCreditMon}
              onChange={(e) => set("budgetCreditMon", e.target.value)}
            />
          </Field>
          <Field
            label="Max finds per player"
            explain="0 disables the cap. Belt-and-braces against one wallet farming the whole hunt; enforced on an atomic per-(hunt, player) counter, never by counting rows."
          >
            <input
              type="number"
              className={inputClass}
              value={v.maxFindsPerPlayer}
              onChange={(e) => set("maxFindsPerPlayer", Number(e.target.value))}
            />
          </Field>
        </div>
      </section>

      <section className="rounded border border-sky-900 bg-sky-950/20 p-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-sky-300">
          Spawns — real native MON leaves the treasury here
        </h3>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          <Field
            label="Spawns enabled"
            explain="The master switch for the only path in the system where money actually leaves. Off means no new spawns are created at all."
          >
            <select
              className={inputClass}
              value={String(v.spawnEnabled)}
              onChange={(e) => set("spawnEnabled", e.target.value === "true")}
            >
              <option value="false">off</option>
              <option value="true">on</option>
            </select>
          </Field>
          <Field
            label="MON budget"
            explain="Hard ceiling on native MON this hunt can ever pay out. Enforced atomically at collect time. This is the number that bounds the worst case if everything else fails."
          >
            <input
              className={inputClass}
              value={v.budgetMon}
              onChange={(e) => set("budgetMon", e.target.value)}
            />
          </Field>
          <Field
            label="Per-player 24h cap (MON)"
            explain="Ceiling on what one player may collect in a rolling day. Bounds a single compromised or spoofing account without needing anyone to notice it first."
          >
            <input
              className={inputClass}
              value={v.spawnDailyCapMonPerPlayer}
              onChange={(e) => set("spawnDailyCapMonPerPlayer", e.target.value)}
            />
          </Field>
          <Field
            label="Spawn min (MON)"
            explain="Lower bound on a single random drop. Around 0.0005 keeps a spawn feeling like a find rather than a payday."
          >
            <input
              className={inputClass}
              value={v.spawnMinMon}
              onChange={(e) => set("spawnMinMon", e.target.value)}
            />
          </Field>
          <Field
            label="Spawn max (MON)"
            explain="Upper bound on a single drop. Every unit you add here multiplies by the number of spawns anyone can farm, so this is the knob that decides how attractive spoofing is."
          >
            <input
              className={inputClass}
              value={v.spawnMaxMon}
              onChange={(e) => set("spawnMaxMon", e.target.value)}
            />
          </Field>
          <Field
            label="Spawn TTL (s)"
            explain="How long a spawn survives. Short is a control: a spoofer needs a plausible movement track to reach one in time, and an expired spawn cannot be banked and swept in a burst."
          >
            <input
              type="number"
              className={inputClass}
              value={v.spawnTtlSeconds}
              onChange={(e) => set("spawnTtlSeconds", Number(e.target.value))}
            />
          </Field>
          <Field
            label="Min radius (m)"
            explain="Inner edge of the annulus around the player's last VERIFIED position. Must be greater than zero — a spawn on top of the player is a payout for standing still."
          >
            <input
              type="number"
              className={inputClass}
              value={v.spawnMinRadiusM}
              onChange={(e) => set("spawnMinRadiusM", Number(e.target.value))}
            />
          </Field>
          <Field
            label="Max radius (m)"
            explain="Outer edge of the annulus. Must be strictly greater than the minimum. Wide radii make spawns harder to reach in the TTL, which is a difficulty knob and an anti-spoofing one at the same time."
          >
            <input
              type="number"
              className={inputClass}
              value={v.spawnMaxRadiusM}
              onChange={(e) => set("spawnMaxRadiusM", Number(e.target.value))}
            />
          </Field>
          <Field
            label="Spawn cooldown (s)"
            explain="Minimum seconds between spawns granted to the same player. Directly caps their maximum earn rate."
          >
            <input
              type="number"
              className={inputClass}
              value={v.spawnCooldownSeconds}
              onChange={(e) =>
                set("spawnCooldownSeconds", Number(e.target.value))
              }
            />
          </Field>
        </div>
      </section>

      <section
        className={`rounded border p-3 ${
          autoApproveOff
            ? "border-slate-800 bg-slate-900/40"
            : "border-amber-800 bg-amber-950/20"
        }`}
      >
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-amber-300">
          Auto-approval policy
        </h3>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-400">
          Auto-approval is the only way MON moves without a person looking at
          it. Setting the maximum to <span className="font-mono">0</span>{" "}
          disables it entirely and restores the strict human gate. A payout
          whose claim attempt was flagged never auto-approves, whatever these
          numbers say.
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          <Field
            label="Auto-approve max (MON)"
            explain="Largest single payout that may be released without a human. Anything above it waits in the queue. Keep it below your spawn maximum, or every spawn auto-approves."
          >
            <input
              className={inputClass}
              value={v.autoApproveMaxMon}
              onChange={(e) => set("autoApproveMaxMon", e.target.value)}
            />
          </Field>
          <Field
            label="Auto-approve 24h cap (MON)"
            explain="Ceiling on what auto-approval may release across the whole hunt in a rolling day. Once exceeded, everything falls back to PENDING until a human intervenes. This is what bounds the damage if the verifier is ever fooled at scale — set it to what you could afford to lose in a day."
          >
            <input
              className={inputClass}
              value={v.autoApproveDailyCapMon}
              onChange={(e) => set("autoApproveDailyCapMon", e.target.value)}
            />
          </Field>
        </div>
      </section>

      <div>
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded bg-slate-100 px-4 py-1.5 text-xs font-semibold text-slate-900 hover:bg-white disabled:opacity-50"
        >
          {busy ? "saving…" : "Save hunt settings"}
        </button>
        <span className="ml-3 text-[11px] text-slate-500">
          Every field that actually changes is written to the audit trail with
          its before and after value.
        </span>
      </div>
    </div>
  );
}
