"use client";

import { useEffect, useState } from "react";
import { Note, Panel, Stat } from "@/components/ui/primitives";

// ---------------------------------------------------------------------------
// What the spot trades made, next to what the perps made.
//
// BOTH UNITS, DELIBERATELY. The same round trip on 4 October reads as +105.38
// MON and as exactly $0.00 — 1,629 MON sold for $58.50 and 1,734 bought back
// with the same $58.50, because MON fell 6% in between. Neither number is the
// honest one on its own: dollars say nothing happened, MON says it was a win,
// and which matters depends on whether the next thing spent is a spawn or an
// invoice. A treasury denominated in MON is right to read the MON line.
// ---------------------------------------------------------------------------

type Lang = "es" | "en";

const T = {
  es: {
    title: "Contado (Kuru)",
    lede: "Compras y ventas de MON en el libro, con base de costo FIFO.",
    realised: "Realizado",
    realisedSub: "en dólares, de ventas cerradas",
    netMon: "MON neto",
    netMonSub: "comprado menos vendido",
    gas: "Gas",
    gasSub: "pagado en total, incluidas las fallidas",
    open: "Sin vender",
    openSub: "MON en mano y lo que costó",
    empty: "Todavía no hay operaciones de contado.",
    unpriced: (n: number) =>
      n === 1
        ? "1 compra sin monto confirmado; no entra en el cálculo."
        : `${n} compras sin monto confirmado; no entran en el cálculo.`,
    day: "24 h",
    week: "7 d",
    month: "30 d",
    all: "Todo",
    bothNote:
      "Las dos cifras son ciertas. En dólares una ida y vuelta puede quedar en cero mientras el MON sube — y el MON es lo que gastas en recompensas.",
  },
  en: {
    title: "Spot (Kuru)",
    lede: "MON bought and sold on the book, with a FIFO cost basis.",
    realised: "Realised",
    realisedSub: "in dollars, from closed sales",
    netMon: "Net MON",
    netMonSub: "bought minus sold",
    gas: "Gas",
    gasSub: "paid in total, failures included",
    open: "Still held",
    openSub: "MON on hand and what it cost",
    empty: "No spot trades yet.",
    unpriced: (n: number) =>
      n === 1
        ? "1 buy has no confirmed amount and is left out of the figures."
        : `${n} buys have no confirmed amount and are left out of the figures.`,
    day: "24h",
    week: "7d",
    month: "30d",
    all: "All",
    bothNote:
      "Both figures are true. A round trip can net zero dollars while gaining MON — and MON is what you pay rewards in.",
  },
} as const;

interface Payload {
  realisedUsd6: string;
  netMonWei: string;
  gasWei: string;
  openMonWei: string;
  openBasisUsd6: string;
  unpriced: number;
  trades: number;
}

const mon = (wei: string) => {
  const w = BigInt(wei);
  const neg = w < 0n;
  const a = neg ? -w : w;
  return `${neg ? "−" : ""}${a / 10n ** 18n}.${(((a % 10n ** 18n) * 100n) / 10n ** 18n).toString().padStart(2, "0")}`;
};
const usd = (a6: string) => {
  const v = BigInt(a6);
  const neg = v < 0n;
  const a = neg ? -v : v;
  return `${neg ? "−" : ""}${a / 1_000_000n}.${(((a % 1_000_000n) * 100n) / 1_000_000n).toString().padStart(2, "0")}`;
};

export function SpotResults({
  lang,
  wallet,
}: {
  lang: Lang;
  wallet: string | null;
}) {
  const t = T[lang];
  const [data, setData] = useState<Payload | null>(null);
  const [period, setPeriod] = useState<"day" | "week" | "month" | "all">("all");

  useEffect(() => {
    if (!wallet) return;
    let live = true;
    void (async () => {
      try {
        const r = await fetch(
          `/api/cota/spot-pnl?wallet=${encodeURIComponent(wallet)}&period=${period}`,
          { cache: "no-store" },
        );
        if (!r.ok) return;
        const j = (await r.json()) as Payload;
        if (live) setData(j);
      } catch {
        // Leaves the section absent rather than showing zeros, which would
        // read as "you traded nothing".
      }
    })();
    return () => {
      live = false;
    };
  }, [wallet, period]);

  if (!data) return null;

  if (data.trades === 0) {
    return (
      <Panel className="space-y-1">
        <p className="text-ink text-sm font-semibold">{t.title}</p>
        <p className="text-ink-faint text-xs">{t.empty}</p>
      </Panel>
    );
  }

  const netPositive = BigInt(data.netMonWei) >= 0n;

  return (
    <Panel className="space-y-3">
      <div>
        <p className="text-ink text-sm font-semibold">{t.title}</p>
        <p className="text-ink-faint mt-0.5 text-xs">{t.lede}</p>
      </div>

      {/* The window. Asked for because "is this total?" was the first question
          the figures raised, and it was — there was nothing on screen saying
          so. A windowed figure is NOT a slice of the lifetime one: a sale of
          MON bought before the window shows its full proceeds, because inside
          the window nothing was paid for it. */}
      <div className="grid grid-cols-4 gap-2">
        {(["day", "week", "month", "all"] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPeriod(p)}
            className={`min-h-9 rounded-lg border text-xs ${
              period === p
                ? "border-phosphor text-phosphor"
                : "border-hull-line text-ink-dim"
            }`}
          >
            {t[p]}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Stat
          label={t.netMon}
          value={`${netPositive ? "+" : ""}${mon(data.netMonWei)}`}
          sub={t.netMonSub}
          tone="mon"
        />
        <Stat
          label={t.realised}
          value={`$${usd(data.realisedUsd6)}`}
          sub={t.realisedSub}
          tone={BigInt(data.realisedUsd6) < 0n ? "warn" : "credit"}
        />
        <Stat
          label={t.open}
          value={mon(data.openMonWei)}
          sub={`${t.openSub} · $${usd(data.openBasisUsd6)}`}
        />
        <Stat
          label={t.gas}
          value={mon(data.gasWei)}
          sub={t.gasSub}
          tone="warn"
        />
      </div>

      <p className="text-ink-faint text-[11px] leading-snug">{t.bothNote}</p>

      {data.unpriced > 0 && (
        <Note tone="warn">{t.unpriced(data.unpriced)}</Note>
      )}
    </Panel>
  );
}
