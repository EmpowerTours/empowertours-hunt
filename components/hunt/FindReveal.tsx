"use client";

import { useEffect, useRef } from "react";
import { Button, LinkButton } from "@/components/ui/primitives";
import {
  TURBO_MONTH_WEI,
  formatMon,
  ipfsUrl,
  turboProgressPercent,
  weiOrZero,
} from "./format";
import type { ClaimFound } from "./types";

/* ---------------------------------------------------------------------------
   The reward moment.

   This is the only screen in the app that is allowed to be loud. The player has
   physically walked somewhere; the cache's label, blurb and photo have been
   held back specifically for this instant, and the credit is the point of the
   whole economy.

   The reveal is honest about what the credit IS: WMON-denominated TURBO credit,
   a discount on a subscription, not withdrawable cash. Saying "you earned
   0.4 MON" here would be the single most misleading sentence in the product.
--------------------------------------------------------------------------- */

export function FindReveal({
  find,
  onDismiss,
}: {
  find: ClaimFound;
  onDismiss: () => void;
}) {
  const dismissRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    dismissRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  const credit = weiOrZero(find.rewardCreditWei);
  const percentOfMonth = turboProgressPercent(credit);

  return (
    <div
      className="bg-void/95 fixed inset-0 z-50 overflow-y-auto backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Cache found"
    >
      {/* Flare — one shot, opacity and transform only. */}
      <div
        className="reveal-flare pointer-events-none absolute top-1/3 left-1/2 h-[120vw] w-[120vw] -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(70,255,190,0.35) 0%, rgba(70,255,190,0.06) 45%, transparent 70%)",
        }}
        aria-hidden
      />

      <div className="safe-top safe-bottom reveal-in relative mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-5 px-5">
        <div className="text-center">
          <div className="text-phosphor font-mono text-sm tracking-[0.4em] uppercase">
            Cache recovered
          </div>
          <h1 className="text-ink mt-2 text-4xl leading-tight font-bold text-balance">
            {find.cache.label ?? "Unmarked cache"}
          </h1>
        </div>

        {find.cache.photoCid ? (
          // The IPFS gateway is configurable at runtime, so a build-time
          // `remotePatterns` entry cannot cover it and `next/image` would
          // refuse the host. A plain <img> is the correct call here.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={ipfsUrl(find.cache.photoCid)}
            alt={find.cache.label ?? "The cache"}
            className="border-hull-line max-h-72 w-full rounded-2xl border object-cover"
            loading="eager"
          />
        ) : null}

        {find.cache.blurb ? (
          <p className="text-ink-dim text-center text-base leading-relaxed text-pretty">
            {find.cache.blurb}
          </p>
        ) : null}

        {/* --- The credit ------------------------------------------------ */}
        <div className="border-phosphor/40 bg-hull rounded-2xl border-2 p-5 text-center">
          <div className="text-ink-dim font-mono text-[11px] tracking-[0.24em] uppercase">
            TURBO credit earned
          </div>
          <div className="text-phosphor mt-1 font-mono text-5xl leading-none font-bold">
            {formatMon(credit)}
          </div>
          <div className="text-ink-dim mt-1 font-mono text-sm">WMON</div>

          <div className="bg-hull-2 mt-4 h-2 w-full overflow-hidden rounded-full">
            <div
              className="bg-phosphor h-full rounded-full"
              style={{ width: `${Math.max(percentOfMonth, 1.5)}%` }}
            />
          </div>
          <p className="text-ink-faint mt-2 text-xs leading-snug">
            {percentOfMonth.toFixed(1)}% of a TURBO Explorer month (
            {formatMon(TURBO_MONTH_WEI, 0)} WMON). Credit is a discount on the
            cohort subscription — it is not withdrawable MON.
          </p>
        </div>

        {find.creditBalanceWei !== null ? (
          <p className="text-ink-dim text-center font-mono text-sm">
            Balance now{" "}
            <span className="text-phosphor">
              {formatMon(weiOrZero(find.creditBalanceWei))} WMON
            </span>
          </p>
        ) : null}

        <p className="text-ink-dim text-center font-mono text-sm">
          {find.remaining > 0
            ? `${find.remaining} cache${find.remaining === 1 ? "" : "s"} still hidden`
            : "That was the last one."}
        </p>

        <div className="space-y-3">
          <Button ref={dismissRef} type="button" onClick={onDismiss}>
            BACK TO THE SCOPE
          </Button>
          <LinkButton href="/hunt/wallet">View progress</LinkButton>
        </div>
      </div>
    </div>
  );
}
