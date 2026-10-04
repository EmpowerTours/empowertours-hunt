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
  maxNotionalUsdE6: string;
  maxLeverageX100: string;
  notAfter: string;
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
  const markRevoked = (digest: string) =>
    setRows((prev) =>
      prev === null
        ? prev
        : prev.map((r) =>
            r.digest === digest
              ? { ...r, revokedAt: new Date().toISOString() }
              : r,
          ),
    );
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
            <LeashRow key={r.id} row={r} lang={lang} onRevoked={markRevoked} />
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
            <LeashRow key={r.id} row={r} lang={lang} onRevoked={markRevoked} />
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
function LeashRow({
  row,
  lang,
  onRevoked,
}: {
  row: CotaRow;
  lang: "es" | "en";
  onRevoked: (digest: string) => void;
}) {
  // Two taps, because it cannot be undone — the same shape the trade screen
  // uses, and for the same reason.
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const expired = new Date(row.notAfter) <= new Date();
  const live = row.revokedAt === null && !expired;
  const maxUsd = (Number(row.maxNotionalUsdE6) / 1e6).toLocaleString("en-US", {
    maximumFractionDigits: 2,
  });
  const lev = Number(row.maxLeverageX100) / 100;
  const until = new Date(row.notAfter).toLocaleDateString(
    lang === "es" ? "es-MX" : "en-US",
    { month: "short", day: "numeric" },
  );

  const revoke = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const res = await fetch("/api/cota/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ digest: row.digest }),
      });
      const body = (await res.json()) as { revoked?: boolean; error?: string };
      if (!res.ok || !body.revoked) {
        setFailed(body.error ?? "failed");
        return;
      }
      onRevoked(row.digest);
    } catch (e) {
      setFailed(String((e as { message?: string })?.message ?? e));
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };

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
          {/* THE CEILING, which this list never showed. Without it the rows are
              indistinguishable — "perpl · MON" three times over — and a hunter
              asked to revoke the loosest one cannot tell which that is. The
              number is the whole point of the signature. */}
          {marketList} · <span translate="no">${maxUsd}</span> ·{" "}
          <span translate="no">{lev}x</span>
        </div>
        <div className="text-ink-faint text-[11px]">
          {when}
          {row.revokedAt
            ? lang === "es"
              ? " · revocada"
              : " · revoked"
            : expired
              ? lang === "es"
                ? " · vencida"
                : " · expired"
              : `${lang === "es" ? " · vence " : " · expires "}${until}`}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {row.anchorTxHash ? (
          <a
            href={`https://monadscan.com/tx/${row.anchorTxHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[12px] font-medium text-[#4ade80] underline"
          >
            {lang === "es" ? "Anclada ✓" : "Anchored ✓"}
          </a>
        ) : (
          <Pill color="#a1a1aa">
            {lang === "es" ? "sin anclar" : "not anchored"}
          </Pill>
        )}

        {/* REVOKE LIVES HERE because this is the only screen that lists every
            leash. The trade screen can revoke only the one it is holding, and
            it holds one for the market it trades — so a wallet with live BTC
            and PUMP leashes had no way to withdraw them at all. A ceiling you
            cannot take back is not a ceiling: the loosest live leash is the
            real limit, and signing a tighter one changes nothing while the
            looser one stands. */}
        {live &&
          (armed ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void revoke()}
                disabled={busy}
                className="text-alert text-[11px] font-semibold underline disabled:opacity-50"
              >
                {busy
                  ? lang === "es"
                    ? "Revocando…"
                    : "Revoking…"
                  : lang === "es"
                    ? "Confirmar"
                    : "Confirm"}
              </button>
              <button
                type="button"
                onClick={() => setArmed(false)}
                disabled={busy}
                className="text-ink-faint text-[11px] underline"
              >
                {lang === "es" ? "No" : "No"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setArmed(true)}
              className="text-ink-dim text-[11px] underline underline-offset-2"
            >
              {lang === "es" ? "Revocar" : "Revoke"}
            </button>
          ))}
        {failed && <span className="text-alert text-[10px]">{failed}</span>}
      </div>
    </li>
  );
}
