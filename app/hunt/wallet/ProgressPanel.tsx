"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
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
  const t = useTranslations("wallet");
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
            message: e instanceof ApiError ? e.message : t("serverUnreachable"),
          });
        }
      });
    return () => controller.abort();
  }, []);

  if (state.kind === "loading") {
    return (
      <Panel>
        <p className="text-ink-dim font-mono text-sm">{t("reading")}</p>
      </Panel>
    );
  }

  if (state.kind === "missing") {
    return (
      <div className="space-y-3">
        <Note title={t("missingTitle")}>
          {t.rich("missingBody", {
            code: (chunks) => <code className="font-mono">{chunks}</code>,
          })}
        </Note>
        <Panel>
          <div className="text-ink-dim font-mono text-[11px] tracking-[0.18em] uppercase">
            {t("signedInAs")}
          </div>
          <div className="text-ink mt-1 font-mono text-lg">
            {auth.status === "signed-in" || auth.status === "blocked"
              ? shortAddress(auth.walletAddress)
              : t("notSignedInValue")}
          </div>
          <p className="text-ink-faint mt-2 text-xs leading-snug">
            {t("creditExplainer", { month: formatMon(TURBO_MONTH_WEI, 0) })}
          </p>
        </Panel>
      </div>
    );
  }

  if (state.kind === "signed-out") {
    return <Note title={t("signedOutTitle")}>{t("signedOutBody")}</Note>;
  }

  if (state.kind === "error") {
    return (
      <Note tone="warn" title={t("errorTitle")}>
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
            {t("turboCredit")}
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
              aria-label={t("progressAria")}
            />
          </div>

          <p className="text-ink mt-2 text-sm">
            {percent >= 100
              ? t("coversMonth")
              : t("percentOfMonth", {
                  percent: percent.toFixed(1),
                  remaining: formatMon(remaining, 2),
                })}
          </p>
          <p className="text-ink-faint mt-2 text-xs leading-snug">
            {t("creditNote", { month: formatMon(TURBO_MONTH_WEI, 0) })}
          </p>
        </Panel>
      ) : null}

      {/* --- What is actually in the wallet --------------------------------
          The chain, not the game's bookkeeping. A player who has just been
          paid wants to see the number their wallet would show, and the two
          differ for the minutes between approval and the sweep. */}
      <Panel className="border-spawn/40">
        <div className="text-ink-dim font-mono text-[11px] tracking-[0.24em] uppercase">
          {t("walletBalance")}
        </div>
        {progress.walletBalanceWei === null ||
        progress.walletBalanceWei === undefined ? (
          // Not "0". Rendering an unread balance as empty tells somebody who
          // was just paid that they were not.
          <div className="text-ink-faint mt-1 font-mono text-2xl">—</div>
        ) : (
          <div className="text-spawn mt-1 font-mono text-4xl leading-none font-bold">
            {formatMon(weiOrZero(progress.walletBalanceWei))}
          </div>
        )}
        <div className="text-ink-dim mt-1 font-mono text-sm">
          {progress.walletBalanceWei === null ||
          progress.walletBalanceWei === undefined
            ? t("couldNotReadChain")
            : t("onChain")}
        </div>
        {progress.walletAddress ? (
          <p className="text-ink-faint mt-3 font-mono text-[11px] break-all">
            {progress.walletAddress}
          </p>
        ) : null}
      </Panel>

      {/* --- Earned through this hunt ------------------------------------- */}
      <Panel className="border-spawn/40">
        <div className="text-ink-dim font-mono text-[11px] tracking-[0.24em] uppercase">
          {t("monFromSpawns")}
        </div>
        <div className="text-spawn mt-1 font-mono text-4xl leading-none font-bold">
          {formatMon(weiOrZero(progress.collectedMonWei))}
        </div>
        <div className="text-ink-dim mt-1 font-mono text-sm">
          {t("monSettled")}
        </div>
        {weiOrZero(progress.pendingMonWei) > 0n ? (
          <p className="text-ink-dim mt-3 text-sm">
            {t("pendingMon", {
              amount: formatMon(weiOrZero(progress.pendingMonWei)),
            })}
          </p>
        ) : null}
      </Panel>

      {/* --- Receipts ------------------------------------------------------
          The point of the screen. "3 MON settled" with nothing to check it
          against asks the player to trust the app, which is the wrong posture
          for a thing whose whole claim is that it can be verified. Every sent
          payout links to the transaction; one still moving says so plainly
          rather than showing a dead link. */}
      {progress.payouts && progress.payouts.length > 0 ? (
        <Panel>
          <div className="text-ink-dim font-mono text-[11px] tracking-[0.24em] uppercase">
            {t("payouts")}
          </div>
          <ul className="mt-3 space-y-2">
            {progress.payouts.map((p) => {
              const sent = p.txHash !== null && p.txHash.length > 0;
              return (
                <li
                  key={p.id}
                  className="border-hull-line flex items-center justify-between gap-3 border-b pb-2 last:border-0 last:pb-0"
                >
                  <div>
                    <div className="text-ink font-mono text-sm">
                      {formatMon(weiOrZero(p.amountMonWei))} MON
                    </div>
                    <div className="text-ink-faint font-mono text-[11px]">
                      {new Date(p.at).toLocaleString()}
                    </div>
                  </div>
                  {sent ? (
                    <a
                      href={`https://monadscan.com/tx/${p.txHash}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-spawn shrink-0 font-mono text-xs underline"
                    >
                      {t("receipt")}
                    </a>
                  ) : (
                    <span className="text-ink-faint shrink-0 font-mono text-xs">
                      {t("onItsWay")}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="text-ink-faint mt-3 text-xs leading-snug">
            {t("payoutsNote")}
          </p>
        </Panel>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <Stat label={t("cachesFound")} value={String(progress.findCount)} />
        <Stat
          label={t("spawnsSwept")}
          value={String(progress.spawnCount)}
          tone="mon"
        />
      </div>

      {progress.turboUsername ? (
        <Panel>
          <div className="text-ink-dim font-mono text-[11px] tracking-[0.18em] uppercase">
            {t("turboHandle")}
          </div>
          <div className="text-ink mt-1 font-mono text-lg">
            {progress.turboUsername}
          </div>
          <p className="text-ink-faint mt-2 text-xs">{t("turboHandleNote")}</p>
        </Panel>
      ) : (
        <Note title={t("noHandleTitle")}>{t("noHandleBody")}</Note>
      )}
    </div>
  );
}
