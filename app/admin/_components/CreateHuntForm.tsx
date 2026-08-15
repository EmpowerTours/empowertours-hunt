"use client";

// New hunts are created inactive, with spawns off and auto-approval off. That
// is enforced server-side, not here — this form only collects a name.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { adminPost } from "@/app/admin/_components/api";

export function CreateHuntForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Hunt name"
          className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
          className="min-w-64 flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
        />
        <button
          type="button"
          disabled={busy || name.trim().length < 3}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const res = await adminPost<{ huntId: string }>(
              "/api/admin/hunts",
              {
                name,
                description,
              },
            );
            setBusy(false);
            if (!res.ok) {
              setError(res.error);
              return;
            }
            setName("");
            setDescription("");
            router.push(`/admin/hunts/${res.data.huntId}`);
            router.refresh();
          }}
          className="rounded bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-900 disabled:opacity-50"
        >
          {busy ? "…" : "Create hunt"}
        </button>
      </div>
      <p className="text-[11px] text-slate-500">
        Created inactive, spawns disabled, auto-approval off. Turning each of
        those on is a separate, audited decision.
      </p>
      {error && <p className="text-[11px] text-red-300">{error}</p>}
    </div>
  );
}
