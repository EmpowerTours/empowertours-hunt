"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { Note, Panel, Pill, Stat } from "@/components/ui/primitives";
import { LanguageSwitch } from "@/components/hunt/LanguageSwitch";
import { formatMon, weiToMon } from "@/lib/cota/mon-moved";

// ---------------------------------------------------------------------------
// MON moved, per wallet, over the contest week.
//
// Read-only and unauthenticated by design — every row underneath it is already
// on a public chain, so there is nothing here a rival could not check against
// Monad themselves, and that is the point of showing it rather than a figure
// only we can see.
//
// THE INCOMPLETE FLAG IS NOT DECORATION. A wallet with an undecoded buy has a
// total that is a floor, and the screen says so next to the number instead of
// printing it as a measurement. The alternative — counting an unknown as zero —
// is the one presentation that makes us look worse than we are while sounding
// more precise, and it is exactly what the nullable column was added to avoid.
// ---------------------------------------------------------------------------

type Lang = "es" | "en";

const T = {
  es: {
    title: "MON movido",
    lede: "Por cartera, durante la semana del concurso.",
    back: "Cota",
    window: "Ventana",
    total: "MON movido",
    totalSub: "todas las carteras, en la ventana",
    wallets: "Carteras",
    walletsSub: "con actividad en la ventana",
    empty: "Todavía no hay actividad en esta ventana.",
    emptyNote:
      "Cuenta el MON vendido y comprado en Kuru y el MON operado en el perpetuo de MON. Aparecerá en cuanto se registre la primera operación.",
    sold: "Vendido",
    bought: "Comprado",
    perp: "Perpetuo",
    floor: "MÍNIMO",
    floorNote:
      "Alguna compra no se pudo descifrar, así que este total es un mínimo, no una medición.",
    unresolved: (n: number) =>
      n === 1 ? "1 compra sin descifrar" : `${n} compras sin descifrar`,
    spot: "contado",
  },
  en: {
    title: "MON moved",
    lede: "Per wallet, across the contest week.",
    back: "Cota",
    window: "Window",
    total: "MON moved",
    totalSub: "all wallets, inside the window",
    wallets: "Wallets",
    walletsSub: "active inside the window",
    empty: "No activity in this window yet.",
    emptyNote:
      "Counts MON sold and bought on Kuru plus MON traded on the MON perpetual. It appears as soon as the first trade is recorded.",
    sold: "Sold",
    bought: "Bought",
    perp: "Perp",
    floor: "FLOOR",
    floorNote:
      "At least one buy could not be decoded, so this total is a floor rather than a measurement.",
    unresolved: (n: number) =>
      n === 1 ? "1 buy not decoded" : `${n} buys not decoded`,
    spot: "spot",
  },
} as const;

interface Standing {
  wallet: string;
  spotSoldWei: string;
  spotBoughtWei: string;
  perpUnits: number;
  totalMon: number;
  unresolvedBuys: number;
  complete: boolean;
}

interface Payload {
  window: { from: string; to: string };
  standings: Standing[];
  totalMon: number;
  anyIncomplete: boolean;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const day = (iso: string, lang: Lang) =>
  new Date(iso).toLocaleDateString(lang === "es" ? "es-MX" : "en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "Asia/Singapore",
  });

export default function LeaderboardPage() {
  const locale = useLocale();
  const lang: Lang = locale === "en" ? "en" : "es";
  const t = T[lang];

  const [data, setData] = useState<Payload | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const r = await fetch("/api/cota/mon-moved", { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as Payload;
        if (live) {
          setData(j);
          setFailed(false);
        }
      } catch {
        // Keeps whatever was already on screen. A refresh that fails should not
        // blank a figure the viewer was reading.
        if (live) setFailed(true);
      }
    };
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <a href="/cota" className="text-ink-dim font-mono text-xs">
          ← {t.back}
        </a>
        <LanguageSwitch />
      </div>

      <h1 className="font-mono text-xl">{t.title}</h1>
      <p className="text-ink-dim mt-1 text-sm">{t.lede}</p>

      {data ? (
        <>
          <div className="text-ink-faint mt-3 font-mono text-[11px] tracking-[0.14em] uppercase">
            {t.window} · {day(data.window.from, lang)} –{" "}
            {day(
              // The stored end is exclusive, so the last SCORING day is the one
              // before it. Printing the exclusive bound would advertise a day
              // the contest does not count.
              new Date(new Date(data.window.to).getTime() - 1000).toISOString(),
              lang,
            )}{" "}
            SGT
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3">
            <Stat
              label={t.total}
              value={formatMon(data.totalMon, 2)}
              sub={t.totalSub}
              tone="mon"
            />
            <Stat
              label={t.wallets}
              value={String(data.standings.length)}
              sub={t.walletsSub}
            />
          </div>

          {data.anyIncomplete ? (
            <div className="mt-3">
              <Note tone="warn" title={t.floor}>
                {t.floorNote}
              </Note>
            </div>
          ) : null}

          {data.standings.length === 0 ? (
            <div className="mt-3">
              <Panel>
                <div className="text-sm">{t.empty}</div>
                <div className="text-ink-faint mt-1 text-xs">{t.emptyNote}</div>
              </Panel>
            </div>
          ) : (
            <ol className="mt-3 space-y-2">
              {data.standings.map((s, i) => (
                <li key={s.wallet}>
                  <Panel>
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="flex items-baseline gap-2">
                        <span className="text-ink-faint font-mono text-xs">
                          {i + 1}
                        </span>
                        <span className="font-mono text-sm">
                          {short(s.wallet)}
                        </span>
                        {s.complete ? null : (
                          <Pill className="text-alert">{t.floor}</Pill>
                        )}
                      </div>
                      <span className="text-spawn font-mono text-lg leading-none">
                        {formatMon(s.totalMon, 2)}
                      </span>
                    </div>
                    <div className="text-ink-faint mt-2 grid grid-cols-3 gap-2 font-mono text-[11px]">
                      <div>
                        {t.sold} {formatMon(weiToMon(s.spotSoldWei), 2)}
                        <div className="opacity-60">{t.spot}</div>
                      </div>
                      <div>
                        {t.bought} {formatMon(weiToMon(s.spotBoughtWei), 2)}
                        <div className="opacity-60">{t.spot}</div>
                      </div>
                      <div>
                        {t.perp} {formatMon(s.perpUnits, 2)}
                        <div className="opacity-60">MON</div>
                      </div>
                    </div>
                    {s.unresolvedBuys > 0 ? (
                      <div className="text-alert mt-2 text-xs">
                        {t.unresolved(s.unresolvedBuys)}
                      </div>
                    ) : null}
                  </Panel>
                </li>
              ))}
            </ol>
          )}
        </>
      ) : (
        <div className="mt-3">
          <Panel>
            <div className="text-ink-dim text-sm">…</div>
          </Panel>
        </div>
      )}

      {failed && data ? (
        <div className="text-ink-faint mt-2 text-xs">·</div>
      ) : null}
    </main>
  );
}
