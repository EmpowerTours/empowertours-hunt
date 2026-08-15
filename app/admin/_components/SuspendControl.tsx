"use client";

// Suspend / unsuspend a player. A reason is required in both directions —
// reinstating a wallet that was flagged for spoofing is as much of a decision
// as suspending it, and the audit trail should say why in both cases.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { adminPost } from "@/app/admin/_components/api";

export function SuspendControl({
  playerId,
  suspended,
  canOperate,
  compact = false,
}: {
  playerId: string;
  suspended: boolean;
  canOperate: boolean;
  compact?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canOperate) return null;

  const action = suspended ? "unsuspend" : "suspend";

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`rounded border px-2 py-0.5 text-[11px] ${
          suspended
            ? "border-emerald-700 text-emerald-300 hover:bg-emerald-950"
            : "border-red-800 text-red-300 hover:bg-red-950"
        } ${compact ? "" : "px-3 py-1"}`}
      >
        {suspended ? "Unsuspend" : "Suspend"}
      </button>
    );
  }

  return (
    <div className="flex min-w-56 flex-col gap-1">
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={
          suspended
            ? "Why is this being lifted? (required)"
            : "What did they do? (required)"
        }
        className="rounded border border-slate-700 bg-slate-900 px-1 py-1 text-[11px]"
      />
      <div className="flex gap-1">
        <button
          type="button"
          disabled={busy || reason.trim().length < 6}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const res = await adminPost(
              `/api/admin/players/${playerId}/${action}`,
              { reason },
            );
            setBusy(false);
            if (!res.ok) {
              setError(res.error);
              return;
            }
            setOpen(false);
            setReason("");
            router.refresh();
          }}
          className="rounded bg-slate-700 px-2 py-1 text-[11px] text-white hover:bg-slate-600 disabled:opacity-40"
        >
          {busy ? "…" : `Confirm ${action}`}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-400"
        >
          cancel
        </button>
      </div>
      {error && <p className="text-[11px] text-red-300">{error}</p>}
    </div>
  );
}
