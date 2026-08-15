"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { adminPost } from "@/app/admin/_components/api";

export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await adminPost("/api/admin/auth/logout");
        router.push("/admin/login");
        router.refresh();
      }}
      className="rounded border border-slate-700 px-2 py-0.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100 disabled:opacity-50"
    >
      {busy ? "…" : "sign out"}
    </button>
  );
}
