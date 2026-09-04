"use client";

import { useEffect, useState } from "react";
import { useAuthSlot } from "@/app/providers";
import { ApiError, fetchProgress } from "@/components/hunt/client";
import {
  TURBO_MONTH_WEI,
  formatMon,
  shortAddress,
  turboProgressPercent,
  weiOrZero,
} from "@/components/hunt/format";
import type { PlayerProgress } from "@/components/hunt/types";
import { Note, Panel, Stat } from "@/components/ui/primitives";

/* ---------------------------------------------------------------------------
   Two balances that must never be conflated.

     TURBO CREDIT — WMON-denominated, NOT withdrawable. A discount on a cohort
     subscription. This is what a cache find pays.

     MON — real native currency, actually leaves the treasury. Only spawns pay
     it, and only after a payout settles on chain.

   Showing them in one number would be the most expensive lie in the product,
   so they get separate cards, separate colours and separate words.
--------------------------------------------------------------------------- */

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; progress: PlayerProgress }
  | { kind: "missing" }
  | { kind: "signed-out" }
  | { kind: "error"; message: string };

export function ProgressPanel() {
  const auth = useAuthSlot();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    fetchProgress(controller.signal)
      .then((progress) => setState({ kind: "ready", progress }))
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        if (e instanceof ApiError && e.notImplemented) {
          setState({ kind: "missing" });
        } else if (e instanceof ApiError && e.status === 401) {
          setState({ kind: "signed-out" });
        } else {
          setState({
            kind: "error",
            message:
              e instanceof ApiError ? e.message : "Could not reach the server.",
          });
        }
      });
    return () => controller.abort();
  }, []);

  if (state.kind === "loading") {
    return (
      <Panel>
        <p className="text-ink-dim font-mono text-sm">Reading ledger…</p>
      </Panel>
    );
  }

  if (state.kind === "missing") {
    return (
      <div className="space-y-3">
        <Note title="Balance endpoint not built">
          <code className="font-mono">GET /api/me</code> does not exist yet, so
          this screen has nothing truthful to show. It deliberately shows
          nothing rather than a zero it cannot vouch for — a balance of
          &ldquo;0&rdquo; you have not earned is worse than no balance at all.
        </Note>
        <Panel>
          <div className="text-ink-dim font-mono text-[11px] tracking-[0.18em] uppercase">
            Signed in as
          </div>
          <div className="text-ink mt-1 font-mono text-lg">
            {auth.status === "signed-in" || auth.status === "blocked"
              ? shortAddress(auth.walletAddress)
              : "not signed in"}
          </div>
          <p className="text-ink-faint mt-2 text-xs leading-snug">
            Credit is earned from cache finds and shown here once the ledger is
            exposed. It is denominated in WMON-wei against a{" "}
            {formatMon(TURBO_MONTH_WEI, 0)} WMON Explorer month.
          </p>
        </Panel>
      </div>
    );
  }

  if (state.kind === "signed-out") {
    return (
      <Note title="Not signed in">
        Sign in to see your credit. Balances are per wallet.
      </Note>
    );
  }

  if (state.kind === "error") {
    return (
      <Note tone="warn" title="Could not load your balance">
        {state.message}
      </Note>
    );
  }

  const { progress } = state;
  const credit = weiOrZero(progress.creditBalanceWei);
  const percent = turboProgressPercent(credit);
  const remaining = TURBO_MONTH_WEI > credit ? TURBO_MONTH_WEI - credit : 0n;

  return (
    <div className="space-y-4">
      {/* --- TURBO credit -------------------------------------------------
          Shown only once there is some.

          Credit is earned by finding CACHES, and a spawn-only hunt has none —
          so on the hunt most players are on, this panel read "0 WMON · 0% of
          an Explorer month" to somebody who had no way to earn either and no
          idea what an Explorer month was. Nothing is removed: place a cache
          with a reward and the panel returns by itself. */}
      {credit > 0n ? (
      <Panel className="border-phosphor/40">
        <div className="text-ink-dim font-mono text-[11px] tracking-[0.24em] uppercase">
          TURBO credit
        </div>
        <div className="text-phosphor mt-1 font-mono text-5xl leading-none font-bold">
          {formatMon(credit)}
        </div>
        <div className="text-ink-dim mt-1 font-mono text-sm">WMON</div>

        <div className="bg-hull-2 mt-4 h-3 w-full overflow-hidden rounded-full">
          <div
            className="bg-phosphor h-full rounded-full transition-[width]"
            style={{ width: `${percent}%` }}
            role="progressbar"
            aria-valuenow={Math.round(percent)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Progress toward a TURBO Explorer month"
          />
        </div>

        <p className="text-ink mt-2 text-sm">
          {percent >= 100
            ? "That covers a full TURBO Explorer month."
            : `${percent.toFixed(1)}% of an Explorer month — ${formatMon(remaining, 2)} WMON to go.`}
        </p>
        <p className="text-ink-faint mt-2 text-xs leading-snug">
          Credit is a discount on the TURBO cohort subscription (
          {formatMon(TURBO_MONTH_WEI, 0)} WMON per Explorer month). It is not
          withdrawable and cannot be sent anywhere.
        </p>
      </Panel>
      ) : null}

      {/* --- Real MON ----------------------------------------------------- */}
      <Panel className="border-spawn/40">
        <div className="text-ink-dim font-mono text-[11px] tracking-[0.24em] uppercase">
          MON from spawns
        </div>
        <div className="text-spawn mt-1 font-mono text-4xl leading-none font-bold">
          {formatMon(weiOrZero(progress.collectedMonWei))}
        </div>
        <div className="text-ink-dim mt-1 font-mono text-sm">MON · settled</div>
        {weiOrZero(progress.pendingMonWei) > 0n ? (
          <p className="text-ink-dim mt-3 text-sm">
            {formatMon(weiOrZero(progress.pendingMonWei))} MON is earned but not
            yet sent. Payouts are released deliberately, not instantly.
          </p>
        ) : null}
      </Panel>

      <div className="grid grid-cols-2 gap-3">
        <Stat label="Caches found" value={String(progress.findCount)} />
        <Stat
          label="Spawns swept"
          value={String(progress.spawnCount)}
          tone="mon"
        />
      </div>

      {progress.turboUsername ? (
        <Panel>
          <div className="text-ink-dim font-mono text-[11px] tracking-[0.18em] uppercase">
            TURBO handle
          </div>
          <div className="text-ink mt-1 font-mono text-lg">
            {progress.turboUsername}
          </div>
          <p className="text-ink-faint mt-2 text-xs">
            Credit redeems against this builder identity.
          </p>
        </Panel>
      ) : (
        <Note title="No TURBO handle linked">
          Credit accrues either way, but it can only be redeemed once a TURBO
          registry handle is linked to this wallet.
        </Note>
      )}
    </div>
  );
}
