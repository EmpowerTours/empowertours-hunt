"use client";

// Manual TURBO credit adjustment.
//
// The ledger is append-only: a revocation is a new negative entry, never an
// edit of the entry that granted it. The amount is typed in WMON and parsed
// server-side by `parseMonInput`.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { adminPost } from "@/app/admin/_components/api";

export function CreditAdjust({ playerId }: { playerId: string }) {
  const router = useRouter();
  const [direction, setDirection] = useState<"GRANT" | "REVOKE">("GRANT");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-[10px] uppercase tracking-wider text-slate-500">
          direction
          <select
            value={direction}
            onChange={(e) =>
              setDirection(e.target.value === "REVOKE" ? "REVOKE" : "GRANT")
            }
            className="mt-1 block rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
          >
            <option value="GRANT">grant</option>
            <option value="REVOKE">revoke</option>
          </select>
        </label>
        <label className="text-[10px] uppercase tracking-wider text-slate-500">
          amount (WMON)
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="139"
            className="mt-1 block rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-xs text-slate-100"
          />
        </label>
        <label className="min-w-64 flex-1 text-[10px] uppercase tracking-wider text-slate-500">
          reason
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why (required, kept in the ledger and the audit trail)"
            className="mt-1 block w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
          />
        </label>
        <button
          type="button"
          disabled={busy || amount.trim() === "" || note.trim().length < 6}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const res = await adminPost(
              `/api/admin/players/${playerId}/credit`,
              { direction, amount, note },
            );
            setBusy(false);
            if (!res.ok) {
              setError(res.error);
              return;
            }
            setAmount("");
            setNote("");
            router.refresh();
          }}
          className="rounded bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-900 disabled:opacity-50"
        >
          {busy ? "…" : "Apply"}
        </button>
      </div>
      <p className="text-[11px] text-slate-500">
        Credit is denominated in WMON-wei and is not withdrawable — it is a
        discount against a TURBO cohort subscription. A revocation is refused if
        the player does not currently hold that much.
      </p>
      {error && <p className="text-[11px] text-red-300">{error}</p>}
    </div>
  );
}
