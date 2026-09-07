"use client";

// The persistent answer to "did this leash anchor?". The signed panel only
// shows the ✓ for the leash you just signed and is lost on refresh; this reads
// every leash back from the server (which records anchorTxHash only after
// verifying the anchor on-chain) so anchored/not is always visible.

import { useEffect, useState } from "react";
import { Panel, Pill } from "@/components/ui/primitives";

interface CotaRow {
  id: string;
  venue: string;
  markets: string[];
  digest: string;
  revokedAt: string | null;
  anchorTxHash: string | null;
  createdAt: string;
}

export function LeashHistory({
  lang,
  refreshKey,
}: {
  lang: "es" | "en";
  /** Changes when a new leash is signed, to re-fetch and show it. */
  refreshKey?: string | null;
}) {
  const [rows, setRows] = useState<CotaRow[] | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/cota");
        if (!res.ok) return;
        const body = (await res.json()) as { cotas?: CotaRow[] };
        if (live) setRows(body.cotas ?? []);
      } catch {
        // Leave null; nothing to show rather than an error on a history panel.
      }
    })();
    return () => {
      live = false;
    };
  }, [refreshKey]);

  if (!rows || rows.length === 0) return null;

  return (
    <Panel className="space-y-3">
      <h2 className="text-ink text-sm font-semibold">
        {lang === "es" ? "Tus correas" : "Your leashes"}
      </h2>
      <ul className="space-y-2">
        {rows.map((r) => {
          const when = new Date(r.createdAt).toLocaleDateString(
            lang === "es" ? "es-MX" : "en-US",
            { month: "short", day: "numeric" },
          );
          const marketList =
            r.markets.length > 0
              ? r.markets.join(", ")
              : lang === "es"
                ? "ninguno"
                : "none";
          return (
            <li
              key={r.id}
              className="border-hull-line flex items-center justify-between gap-3 rounded-xl border px-3 py-2"
            >
              <div className="min-w-0">
                <div className="text-ink truncate text-sm">
                  {r.venue} · {marketList}
                </div>
                <div className="text-ink-faint text-[11px]">
                  {when}
                  {r.revokedAt
                    ? lang === "es"
                      ? " · revocada"
                      : " · revoked"
                    : ""}
                </div>
              </div>
              {r.anchorTxHash ? (
                <a
                  href={`https://monadscan.com/tx/${r.anchorTxHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-[12px] font-medium text-[#4ade80] underline"
                >
                  {lang === "es" ? "Anclada ✓" : "Anchored ✓"}
                </a>
              ) : (
                <Pill color="#a1a1aa">
                  {lang === "es" ? "sin anclar" : "not anchored"}
                </Pill>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
