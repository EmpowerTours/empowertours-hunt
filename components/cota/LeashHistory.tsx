"use client";

// The persistent answer to "did this leash anchor?". The signed panel only
// shows the ✓ for the leash you just signed and is lost on refresh; this reads
// every leash back from the server (which records anchorTxHash only after
// verifying the anchor on-chain) so anchored/not is always visible.

import { useEffect, useState } from "react";
import { Panel, Pill } from "@/components/ui/primitives";
import { Sheet, SheetOpener } from "@/components/ui/Sheet";

interface CotaRow {
  id: string;
  venue: string;
  markets: string[];
  digest: string;
  revokedAt: string | null;
  anchorTxHash: string | null;
  createdAt: string;
}

/** Matches the wallet's payout list, so the two panels behave the same way. */
const LEASH_PREVIEW = 3;

export function LeashHistory({
  lang,
  refreshKey,
}: {
  lang: "es" | "en";
  /** Changes when a new leash is signed, to re-fetch and show it. */
  refreshKey?: string | null;
}) {
  const [rows, setRows] = useState<CotaRow[] | null>(null);
  const [open, setOpen] = useState(false);

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

  const hidden = rows.length - LEASH_PREVIEW;

  return (
    <>
      <Panel className="space-y-3">
        <h2 className="text-ink text-sm font-semibold">
          {lang === "es" ? "Tus correas" : "Your leashes"}
        </h2>
        <ul className="space-y-2">
          {rows.slice(0, LEASH_PREVIEW).map((r) => (
            <LeashRow key={r.id} row={r} lang={lang} />
          ))}
        </ul>
        {hidden > 0 ? (
          <SheetOpener onClick={() => setOpen(true)}>
            {lang === "es"
              ? `Ver las ${rows.length} correas`
              : `See all ${rows.length} leashes`}
          </SheetOpener>
        ) : null}
      </Panel>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        label={lang === "es" ? "Tus correas" : "Your leashes"}
        closeLabel={lang === "es" ? "Cerrar" : "Close"}
        heading={
          lang === "es"
            ? `${rows.length} ${rows.length === 1 ? "correa" : "correas"}`
            : `${rows.length} ${rows.length === 1 ? "leash" : "leashes"}`
        }
      >
        <ul className="space-y-2">
          {rows.map((r) => (
            <LeashRow key={r.id} row={r} lang={lang} />
          ))}
        </ul>
      </Sheet>
    </>
  );
}

/* Same shape as the wallet's payout row, and for the same reason: the row is
   the evidence. A leash either anchored to AuditAnchorV2 or it did not, and
   the explorer link is how somebody checks that without believing this
   screen. See components/ui/Sheet.tsx. */
function LeashRow({ row, lang }: { row: CotaRow; lang: "es" | "en" }) {
  const when = new Date(row.createdAt).toLocaleDateString(
    lang === "es" ? "es-MX" : "en-US",
    { month: "short", day: "numeric" },
  );
  const marketList =
    row.markets.length > 0
      ? row.markets.join(", ")
      : lang === "es"
        ? "ninguno"
        : "none";
  return (
    <li className="border-hull-line flex items-center justify-between gap-3 rounded-xl border px-3 py-2">
      <div className="min-w-0">
        <div className="text-ink truncate text-sm">
          {row.venue} · {marketList}
        </div>
        <div className="text-ink-faint text-[11px]">
          {when}
          {row.revokedAt ? (lang === "es" ? " · revocada" : " · revoked") : ""}
        </div>
      </div>
      {row.anchorTxHash ? (
        <a
          href={`https://monadscan.com/tx/${row.anchorTxHash}`}
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
}
