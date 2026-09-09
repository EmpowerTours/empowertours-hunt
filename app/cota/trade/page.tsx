"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale } from "next-intl";
import { useAuthSlot } from "@/app/providers";
import { Button, Note, Panel, Pill } from "@/components/ui/primitives";
import { LanguageSwitch } from "@/components/hunt/LanguageSwitch";
import {
  explainDenial,
  mayOpen,
  type DayState,
  type EnforcedBound,
  type ProposedOrder,
} from "@/lib/cota/enforce";
import { leverageX100, usdE6 } from "@/lib/cota/scale";

// ---------------------------------------------------------------------------
// The hunter-facing trade screen. Shows the signed leash, lets a hunter shape
// an order, and gives the leash's verdict live — the same enforce.ts that the
// server-side agent runs on every real order, so what a hunter sees here is
// what will actually be allowed. Execution (the agent placing the order) is the
// next piece; this is the product surface it plugs into.
// ---------------------------------------------------------------------------

type Lang = "es" | "en";

interface CotaRow {
  id: string;
  venue: string;
  markets: string[];
  maxNotionalUsdE6: string;
  maxLeverageX100: string;
  maxDailyLossUsdE6: string;
  maxTradesPerDay: number;
  notBefore: string;
  notAfter: string;
  digest: string;
  revokedAt: string | null;
  anchorTxHash: string | null;
}

const T = {
  es: {
    title: "Operar",
    lede: "Da forma a una orden. Tu correa firmada decide si se permite — al instante.",
    signIn: "Inicia sesión para operar",
    noCota: "Aún no tienes una correa activa.",
    goSign: "Firmar una correa →",
    leash: "Tu correa",
    market: "Mercado",
    side: "Lado",
    long: "Largo",
    short: "Corto",
    notional: "Tamaño (USD)",
    leverage: "Apalancamiento",
    allowed: "Dentro de tu correa ✓",
    verdict: "Veredicto de la correa",
    maxN: "Tamaño máx.",
    maxL: "Apalanc. máx.",
    dayLoss: "Pérdida diaria máx.",
    trades: "Operaciones/día",
    anchored: "Anclada",
    notAnchored: "sin anclar",
    place: "Colocar (próximamente)",
    placeNote:
      "Colocar pasa por el agente Cota, que ejecuta dentro de esta correa. Ese paso llega enseguida; por ahora esto muestra el veredicto.",
    freshNote:
      "Vista previa contra un día limpio (0 abierto, 0 perdido). El agente usa tu estado real al ejecutar.",
    back: "Cota",
  },
  en: {
    title: "Trade",
    lede: "Shape an order. Your signed leash decides if it's allowed — instantly.",
    signIn: "Sign in to trade",
    noCota: "You don't have an active leash yet.",
    goSign: "Sign a leash →",
    leash: "Your leash",
    market: "Market",
    side: "Side",
    long: "Long",
    short: "Short",
    notional: "Size (USD)",
    leverage: "Leverage",
    allowed: "Within your leash ✓",
    verdict: "Leash verdict",
    maxN: "Max size",
    maxL: "Max leverage",
    dayLoss: "Max daily loss",
    trades: "Trades/day",
    anchored: "Anchored",
    notAnchored: "not anchored",
    place: "Place (coming soon)",
    placeNote:
      "Placing runs through the Cota agent, which executes within this leash. That step is next; for now this shows the verdict.",
    freshNote:
      "Previewed against a clean day (0 open, 0 lost). The agent uses your real state when it executes.",
    back: "Cota",
  },
} as const;

function boundFromRow(c: CotaRow): EnforcedBound {
  return {
    venue: c.venue,
    markets: c.markets,
    maxNotionalUsdE6: BigInt(c.maxNotionalUsdE6),
    maxLeverageX100: BigInt(c.maxLeverageX100),
    maxDailyLossUsdE6: BigInt(c.maxDailyLossUsdE6),
    maxTradesPerDay: c.maxTradesPerDay,
    notBefore: BigInt(Math.floor(new Date(c.notBefore).getTime() / 1000)),
    notAfter: BigInt(Math.floor(new Date(c.notAfter).getTime() / 1000)),
    revokedAt: c.revokedAt ? new Date(c.revokedAt) : null,
  };
}

// Preview only: a clean day. The real day-state (open notional, loss, trades)
// is the agent's to read at execution, and enforce.ts judges it there.
const FRESH_DAY: DayState = {
  tradesToday: 0,
  lossTodayUsdE6: 0n,
  openNotionalUsdE6: 0n,
};

export default function TradePage() {
  const lang: Lang = useLocale() === "es" ? "es" : "en";
  const t = T[lang];
  const auth = useAuthSlot();

  const [cota, setCota] = useState<CotaRow | null | undefined>(undefined);
  const [side, setSide] = useState<"long" | "short">("long");
  const [notional, setNotional] = useState("3");
  const [lev, setLev] = useState("1");
  const [market, setMarket] = useState<string | null>(null);
  // Captured once (state initializer is allowed to be impure); keeps the
  // verdict useMemo pure. A preview doesn't need second-precision "now".
  const [now] = useState(() => BigInt(Math.floor(Date.now() / 1000)));

  useEffect(() => {
    if (auth.status !== "signed-in") return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/cota");
        if (!res.ok) {
          if (live) setCota(null);
          return;
        }
        const body = (await res.json()) as { cotas?: CotaRow[] };
        const active = (body.cotas ?? []).find(
          (c) => c.revokedAt === null && c.markets.length > 0,
        );
        if (live) {
          setCota(active ?? null);
          setMarket(active?.markets[0] ?? null);
        }
      } catch {
        if (live) setCota(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [auth.status]);

  const bound = useMemo(() => (cota ? boundFromRow(cota) : null), [cota]);

  // The leash verdict for the current inputs, computed by the very code the
  // agent enforces with.
  const decision = useMemo(() => {
    if (!bound || !market) return null;
    let order: ProposedOrder;
    try {
      order = {
        venue: bound.venue,
        market,
        notionalUsdE6: usdE6(Number(notional || "0"), "notional"),
        leverageX100: leverageX100(Number(lev || "0"), "leverage"),
      };
    } catch {
      return null; // off-grid / unparseable input
    }
    return mayOpen(bound, FRESH_DAY, order, now);
  }, [bound, market, notional, lev, now]);

  const human = (e6: string) => (Number(e6) / 1e6).toString();

  return (
    <main className="text-ink mx-auto flex min-h-dvh max-w-md flex-col gap-4 px-4 py-6">
      <a href="/cota" className="text-ink-dim w-fit text-sm hover:underline">
        ← {t.back}
      </a>
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t.title}</h1>
          <p className="text-ink-dim mt-1 text-sm">{t.lede}</p>
        </div>
        <LanguageSwitch className="shrink-0" />
      </header>

      {auth.status !== "signed-in" ? (
        <Panel className="space-y-3">
          <Button onClick={() => void auth.signIn()} disabled={!auth.canSignIn}>
            {t.signIn}
          </Button>
        </Panel>
      ) : cota === undefined ? (
        <Panel>
          <p className="text-ink-dim text-sm">…</p>
        </Panel>
      ) : cota === null ? (
        <Panel className="space-y-3">
          <p className="text-ink text-sm">{t.noCota}</p>
          <a
            href="/cota"
            className="bg-phosphor text-void inline-flex min-h-12 items-center justify-center rounded-2xl px-5 text-sm font-semibold"
          >
            {t.goSign}
          </a>
        </Panel>
      ) : (
        <>
          <Panel className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-ink-dim text-xs tracking-wide uppercase">
                {t.leash}
              </p>
              {cota.anchorTxHash ? (
                <a
                  href={`https://monadscan.com/tx/${cota.anchorTxHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-[#4ade80] underline"
                >
                  {t.anchored} ✓
                </a>
              ) : (
                <Pill color="#a1a1aa">{t.notAnchored}</Pill>
              )}
            </div>
            <div className="grid grid-cols-2 gap-1 text-sm">
              <span className="text-ink-dim">{t.market}</span>
              <span className="text-right font-mono">
                {cota.markets.join(", ")}
              </span>
              <span className="text-ink-dim">{t.maxN}</span>
              <span className="text-right font-mono">
                ${human(cota.maxNotionalUsdE6)}
              </span>
              <span className="text-ink-dim">{t.maxL}</span>
              <span className="text-right font-mono">
                {Number(cota.maxLeverageX100) / 100}×
              </span>
              <span className="text-ink-dim">{t.dayLoss}</span>
              <span className="text-right font-mono">
                ${human(cota.maxDailyLossUsdE6)}
              </span>
              <span className="text-ink-dim">{t.trades}</span>
              <span className="text-right font-mono">
                {cota.maxTradesPerDay}
              </span>
            </div>
          </Panel>

          <Panel className="space-y-3">
            <label className="text-ink-dim block text-xs tracking-wide uppercase">
              {t.market}
            </label>
            <div className="flex flex-wrap gap-2">
              {cota.markets.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMarket(m)}
                  className="rounded-lg border px-3 py-1.5 text-sm font-semibold"
                  style={{
                    borderColor: market === m ? "#06b6d4" : "rgba(63,63,70,.4)",
                    color: market === m ? "#06b6d4" : "#a1a1aa",
                  }}
                >
                  {m}
                </button>
              ))}
            </div>

            <label className="text-ink-dim block text-xs tracking-wide uppercase">
              {t.side}
            </label>
            <div className="grid grid-cols-2 gap-2">
              {(["long", "short"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSide(s)}
                  className="min-h-11 rounded-xl border-2 text-sm font-semibold"
                  style={{
                    borderColor: side === s ? "#06b6d4" : "rgba(63,63,70,.4)",
                    color: side === s ? "#06b6d4" : "#a1a1aa",
                  }}
                >
                  {s === "long" ? t.long : t.short}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-ink-dim block text-xs tracking-wide uppercase">
                  {t.notional}
                </label>
                <input
                  inputMode="decimal"
                  value={notional}
                  onChange={(e) =>
                    setNotional(e.target.value.replace(/[^0-9.]/g, ""))
                  }
                  className="border-hull-line text-ink mt-1 w-full rounded-xl border-2 bg-transparent px-3 py-2 font-mono"
                />
              </div>
              <div>
                <label className="text-ink-dim block text-xs tracking-wide uppercase">
                  {t.leverage}
                </label>
                <input
                  inputMode="decimal"
                  value={lev}
                  onChange={(e) =>
                    setLev(e.target.value.replace(/[^0-9.]/g, ""))
                  }
                  className="border-hull-line text-ink mt-1 w-full rounded-xl border-2 bg-transparent px-3 py-2 font-mono"
                />
              </div>
            </div>
          </Panel>

          <Panel className="space-y-2">
            <p className="text-ink-dim text-xs tracking-wide uppercase">
              {t.verdict}
            </p>
            {decision === null ? (
              <p className="text-ink-faint text-sm">—</p>
            ) : decision.ok ? (
              <Pill color="#4ade80">{t.allowed}</Pill>
            ) : (
              <Note tone="stop">{explainDenial(decision.reason)}</Note>
            )}
            <p className="text-ink-faint text-[11px]">{t.freshNote}</p>
          </Panel>

          <Button disabled>{t.place}</Button>
          <p className="text-ink-faint text-center text-[11px]">
            {t.placeNote}
          </p>
        </>
      )}
    </main>
  );
}
