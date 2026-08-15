"use client";

// Admin roster editing. OWNER only, re-checked on the server.
//
// The self-edit guard lives on the server too, but it is mirrored here so the
// UI does not offer an OWNER a button that will always 403: you cannot change
// your own role or deactivate yourself, because losing the last active OWNER
// locks everyone out permanently (the bootstrap path only fires on an empty
// table).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { adminPost } from "@/app/admin/_components/api";

export interface AdminRow {
  id: string;
  walletAddress: string;
  role: string;
  label: string | null;
  active: boolean;
  createdAt: string;
  actions: number;
}

export function AdminRoster({
  admins,
  selfId,
}: {
  admins: AdminRow[];
  selfId: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [role, setRole] = useState("VIEWER");
  const [label, setLabel] = useState("");

  async function mutate(path: string, body: unknown, method: "POST" | "PATCH") {
    setBusy(path);
    setError(null);
    const res = await adminPost(path, body, method);
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return false;
    }
    router.refresh();
    return true;
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <div className="rounded border border-red-700 bg-red-950/60 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2 rounded border border-slate-800 bg-slate-900/60 p-3">
        <label className="text-[10px] uppercase tracking-wider text-slate-500">
          wallet address
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="0x…"
            className="mt-1 block w-96 rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-xs text-slate-100"
          />
        </label>
        <label className="text-[10px] uppercase tracking-wider text-slate-500">
          role
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="mt-1 block rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
          >
            <option value="VIEWER">VIEWER — read only</option>
            <option value="OPERATOR">
              OPERATOR — approve/void payouts, hunts, caches, players
            </option>
            <option value="OWNER">OWNER — all of that, plus admins</option>
          </select>
        </label>
        <label className="text-[10px] uppercase tracking-wider text-slate-500">
          label
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="who this is"
            className="mt-1 block rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
          />
        </label>
        <button
          type="button"
          disabled={busy !== null || address.trim().length !== 42}
          onClick={async () => {
            const ok = await mutate(
              "/api/admin/admins",
              { walletAddress: address.trim(), role, label },
              "POST",
            );
            if (ok) {
              setAddress("");
              setLabel("");
            }
          }}
          className="rounded bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-900 disabled:opacity-50"
        >
          Add admin
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              {[
                "Wallet",
                "Label",
                "Role",
                "State",
                "Actions logged",
                "Since",
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
            {admins.map((a) => {
              const isSelf = a.id === selfId;
              return (
                <tr key={a.id} className={a.active ? undefined : "opacity-50"}>
                  <td className="border-b border-slate-900 px-2 py-1.5 font-mono text-slate-300">
                    {a.walletAddress}
                    {isSelf && (
                      <span className="ml-2 text-[10px] text-slate-500">
                        (you)
                      </span>
                    )}
                  </td>
                  <td className="border-b border-slate-900 px-2 py-1.5 text-slate-400">
                    {a.label ?? "—"}
                  </td>
                  <td className="border-b border-slate-900 px-2 py-1.5">
                    <select
                      value={a.role}
                      disabled={isSelf || busy !== null}
                      onChange={(e) =>
                        mutate(
                          `/api/admin/admins/${a.id}`,
                          { role: e.target.value },
                          "PATCH",
                        )
                      }
                      className="rounded border border-slate-700 bg-slate-950 px-1 py-0.5 text-[11px] text-slate-100 disabled:opacity-50"
                    >
                      <option value="VIEWER">VIEWER</option>
                      <option value="OPERATOR">OPERATOR</option>
                      <option value="OWNER">OWNER</option>
                    </select>
                  </td>
                  <td className="border-b border-slate-900 px-2 py-1.5">
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[10px] uppercase ${
                        a.active
                          ? "border-emerald-800 bg-emerald-950 text-emerald-300"
                          : "border-slate-700 bg-slate-800 text-slate-400"
                      }`}
                    >
                      {a.active ? "active" : "disabled"}
                    </span>
                  </td>
                  <td className="border-b border-slate-900 px-2 py-1.5 font-mono tabular-nums text-slate-400">
                    <a
                      className="underline decoration-slate-700 hover:decoration-slate-400"
                      href={`/admin/audit?adminId=${a.id}`}
                    >
                      {a.actions}
                    </a>
                  </td>
                  <td className="border-b border-slate-900 px-2 py-1.5 font-mono text-slate-500">
                    {a.createdAt}
                  </td>
                  <td className="border-b border-slate-900 px-2 py-1.5">
                    <button
                      type="button"
                      disabled={isSelf || busy !== null}
                      onClick={() =>
                        mutate(
                          `/api/admin/admins/${a.id}`,
                          { active: !a.active },
                          "PATCH",
                        )
                      }
                      className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-40"
                      title={
                        isSelf
                          ? "You cannot deactivate yourself — ask another OWNER."
                          : undefined
                      }
                    >
                      {a.active ? "disable" : "re-enable"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
