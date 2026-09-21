"use client";

// Settle one redemption. The irreversible step.
//
// Behind this button: wrap the settler's WMON shortfall, approve the cohort for
// an exact amount, then payMonthlyFor. Three broadcasts, each awaited to a
// receipt, so it is not a sub-second click — the disabled state matters.
//
// There is deliberately no bulk "settle all". The cohort refuses a second
// payment for the same member inside MIN_PAYMENT_INTERVAL (25 days), so a
// batch would half-succeed in a way that is tedious to unpick, and every
// settlement spends real WMON.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { adminPost } from "@/app/admin/_components/api";

export function SettleRedemption({
  redemptionId,
  months,
  tier,
  disabled,
}: {
  redemptionId: string;
  months: number;
  tier: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  if (disabled) {
    return (
      <span className="text-[11px] text-slate-500">operator role required</span>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          // Two-step, because this spends WMON and cannot be undone. The
          // cohort will not accept a second payment for 25 days, so a misclick
          // is not something you can simply redo.
          if (!confirming) {
            setConfirming(true);
            return;
          }
          setBusy(true);
          setError(null);
          const res = await adminPost(
            `/api/admin/redemptions/${redemptionId}/settle`,
          );
          setBusy(false);
          setConfirming(false);
          if (!res.ok) {
            setError(res.error);
            return;
          }
          router.refresh();
        }}
        className="rounded bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-900 disabled:opacity-50"
      >
        {busy
          ? "settling…"
          : confirming
            ? `confirm — pay ${months} ${tier} month${months === 1 ? "" : "s"}`
            : "Settle"}
      </button>
      {confirming && !busy && (
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="text-[10px] uppercase tracking-wider text-slate-500"
        >
          cancel
        </button>
      )}
      {error && <p className="max-w-64 text-[11px] text-red-300">{error}</p>}
    </div>
  );
}
