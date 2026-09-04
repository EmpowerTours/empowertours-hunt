"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale } from "next-intl";
import { useAuthSlot } from "@/app/providers";
import { Button, Note, Panel } from "@/components/ui/primitives";
import {
  checkHalted,
  close as closePosition,
  emptyAccount,
  formatUsdE6,
  netPnlUsdE6,
  open as openPosition,
  toDayState,
  unrealisedPnlUsdE6,
  type PaperAccount,
  type PaperPosition,
  type Side,
} from "@/lib/cota/sim/engine";
import type { EnforcedBound } from "@/lib/cota/enforce";
import { explainDenial } from "@/lib/cota/enforce";
import { leverageX100, usdE6 } from "@/lib/cota/scale";

// ---------------------------------------------------------------------------
// Practice mode. Real Perpl prices, a real signed bound, no money.
//
// This is what a Hunt player without AUSD uses: they sign a Cota, then trade
// against it here with paper positions marked to the live market. The
// enforcement is the SAME code (lib/cota/enforce.ts) that governs a live Perpl
// order — so practice is the real thing minus the collateral, not a toy that
// behaves differently.
//
// The paper account lives in localStorage: per-viewer, no money, nothing worth
// putting on a server. Reads are wrapped because a private window throws.
// ---------------------------------------------------------------------------

type Lang = "es" | "en";
const KEY = "cota.paper.v1";

interface StoredCota {
  digest: string;
  venue: string;
  markets: string[];
  maxNotionalUsdE6: string;
  maxLeverageX100: string;
  maxDailyLossUsdE6: string;
  maxTradesPerDay: number;
  notBefore: string;
  notAfter: string;
  revokedAt: string | null;
}

const T = {
  es: {
    title: "Modo práctica",
    lede: "Precios reales de Perpl, tu límite firmado, sin dinero. Practica antes de operar de verdad.",
    needCota:
      "Primero firma una Cota. Ese es el límite contra el que vas a practicar.",
    goSign: "Firmar una Cota",
    signIn: "Inicia sesión para practicar",
    bound: "Tu límite",
    market: "Mercado",
    side: "Lado",
    long: "Largo",
    short: "Corto",
    size: "Tamaño (USD)",
    lev: "Apalancamiento",
    openBtn: "Abrir posición",
    positions: "Posiciones abiertas",
    none: "Ninguna posición abierta.",
    closeBtn: "Cerrar",
    pnl: "Ganancia / pérdida del día",
    halted: "Operaciones detenidas hoy",
    reset: "Reiniciar práctica",
    loading: "Cargando precios…",
  },
  en: {
    title: "Practice mode",
    lede: "Real Perpl prices, your signed bound, no money. Practice before trading for real.",
    needCota: "Sign a Cota first. That's the limit you'll practice against.",
    goSign: "Sign a Cota",
    signIn: "Sign in to practice",
    bound: "Your bound",
    market: "Market",
    side: "Side",
    long: "Long",
    short: "Short",
    size: "Size (USD)",
    lev: "Leverage",
    openBtn: "Open position",
    positions: "Open positions",
    none: "No open positions.",
    closeBtn: "Close",
    pnl: "P&L today",
    halted: "Trading halted for today",
    reset: "Reset practice",
    loading: "Loading prices…",
  },
} as const;

function loadAccount(): PaperAccount {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as {
        dayKey: string;
        tradesToday: number;
        realisedPnlUsdE6: string;
        positions: Array<
          Omit<
            PaperPosition,
            "notionalUsdE6" | "entryUsdE6" | "leverageX100" | "openedAt"
          > & {
            notionalUsdE6: string;
            entryUsdE6: string;
            leverageX100: string;
            openedAt: string;
          }
        >;
      };
      return {
        dayKey: p.dayKey,
        tradesToday: p.tradesToday,
        realisedPnlUsdE6: BigInt(p.realisedPnlUsdE6),
        positions: p.positions.map((x) => ({
          market: x.market,
          side: x.side,
          notionalUsdE6: BigInt(x.notionalUsdE6),
          entryUsdE6: BigInt(x.entryUsdE6),
          leverageX100: BigInt(x.leverageX100),
          openedAt: new Date(x.openedAt),
        })),
      };
    }
  } catch {
    /* private window or corrupt — start clean */
  }
  return emptyAccount(new Date());
}

function saveAccount(a: PaperAccount): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        dayKey: a.dayKey,
        tradesToday: a.tradesToday,
        realisedPnlUsdE6: a.realisedPnlUsdE6.toString(),
        positions: a.positions.map((p) => ({
          market: p.market,
          side: p.side,
          notionalUsdE6: p.notionalUsdE6.toString(),
          entryUsdE6: p.entryUsdE6.toString(),
          leverageX100: p.leverageX100.toString(),
          openedAt: p.openedAt.toISOString(),
        })),
      }),
    );
  } catch {
    /* nothing we can do; the session still works in memory */
  }
}

export default function PracticePage() {
  const auth = useAuthSlot();
  const t = T[(useLocale() === "es" ? "es" : "en") as Lang];
  const lang = (useLocale() === "es" ? "es" : "en") as Lang;

  const [cota, setCota] = useState<StoredCota | null>(null);
  const [loadedCota, setLoadedCota] = useState(false);
  const [marks, setMarks] = useState<Map<string, bigint>>(new Map());
  const [account, setAccount] = useState<PaperAccount>(() =>
    typeof window === "undefined" ? emptyAccount(new Date()) : loadAccount(),
  );
  const [market, setMarket] = useState<string | null>(null);
  const [side, setSide] = useState<Side>("long");
  const [size, setSize] = useState(50);
  const [lev, setLev] = useState(2);
  const [error, setError] = useState<string | null>(null);

  // The player's newest live bound.
  useEffect(() => {
    if (auth.status !== "signed-in") return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/cota");
        const body = (await res.json()) as { cotas?: StoredCota[] };
        if (!live) return;
        const active = (body.cotas ?? []).find(
          (c) => c.revokedAt === null && c.markets.length > 0,
        );
        setCota(active ?? null);
        setMarket(active?.markets[0] ?? null);
      } finally {
        if (live) setLoadedCota(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [auth.status]);

  // Live marks, refreshed on a timer so PnL moves.
  useEffect(() => {
    let live = true;
    const pull = async () => {
      try {
        const res = await fetch("/api/cota/markets");
        const body = (await res.json()) as {
          markets?: Array<{ market: string; midUsdE6: string }>;
        };
        if (!live) return;
        setMarks(
          new Map(
            (body.markets ?? []).map((m) => [m.market, BigInt(m.midUsdE6)]),
          ),
        );
      } catch {
        /* keep the last marks; a blip should not blank the book */
      }
    };
    void pull();
    const id = window.setInterval(() => void pull(), 15_000);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    saveAccount(account);
  }, [account]);

  const bound = useMemo<EnforcedBound | null>(() => {
    if (!cota) return null;
    return {
      venue: cota.venue,
      markets: cota.markets,
      maxNotionalUsdE6: BigInt(cota.maxNotionalUsdE6),
      maxLeverageX100: BigInt(cota.maxLeverageX100),
      maxDailyLossUsdE6: BigInt(cota.maxDailyLossUsdE6),
      maxTradesPerDay: cota.maxTradesPerDay,
      notBefore: BigInt(Math.floor(new Date(cota.notBefore).getTime() / 1000)),
      notAfter: BigInt(Math.floor(new Date(cota.notAfter).getTime() / 1000)),
      revokedAt: cota.revokedAt === null ? null : new Date(cota.revokedAt),
    };
  }, [cota]);

  const halted = useMemo(() => {
    if (!bound) return null;
    const d = checkHalted(account, bound, marks, new Date());
    return d.ok ? null : explainDenial(d.reason);
  }, [bound, account, marks]);

  const onOpen = useCallback(() => {
    if (!bound || market === null) return;
    setError(null);
    try {
      const r = openPosition(
        account,
        bound,
        {
          market,
          side,
          notionalUsdE6: usdE6(size, "size"),
          leverageX100: leverageX100(lev, "leverage"),
        },
        marks,
        new Date(),
      );
      if (!r.ok) {
        setError(r.decision.ok ? null : explainDenial(r.decision.reason));
        return;
      }
      setAccount(r.account);
    } catch (e) {
      setError(e instanceof Error ? e.message : "invalid");
    }
  }, [bound, market, side, size, lev, account, marks]);

  const onClose = useCallback(
    (p: PaperPosition) => {
      setAccount(closePosition(account, p, marks, new Date()));
    },
    [account, marks],
  );

  const net = netPnlUsdE6(account, marks);

  if (auth.status !== "signed-in") {
    return (
      <main className="mx-auto w-full max-w-lg p-4">
        <Panel className="space-y-3">
          <h1 className="text-ink text-2xl font-semibold">{t.title}</h1>
          <p className="text-ink-dim text-sm">{t.signIn}</p>
          <Button onClick={() => void auth.signIn()} disabled={!auth.canSignIn}>
            {t.signIn}
          </Button>
        </Panel>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-lg space-y-4 p-4 pb-24">
      <header>
        <h1 className="text-ink text-2xl font-semibold">{t.title}</h1>
        <p className="text-ink-dim mt-1 text-sm">{t.lede}</p>
      </header>

      {loadedCota && !cota ? (
        <Panel className="space-y-3">
          <p className="text-ink text-sm">{t.needCota}</p>
          <a
            href="/cota"
            className="bg-phosphor text-void inline-flex min-h-12 items-center justify-center rounded-2xl px-5 font-semibold"
          >
            {t.goSign}
          </a>
        </Panel>
      ) : cota ? (
        <>
          <Panel>
            <div className="text-ink-dim font-mono text-[11px] tracking-[0.16em] uppercase">
              {t.bound}
            </div>
            <p className="text-ink mt-2 text-sm">
              {cota.venue} · {cota.markets.join(", ")} · ≤ $
              {formatUsdE6(BigInt(cota.maxNotionalUsdE6)).replace("$", "")} ·{" "}
              {Number(cota.maxLeverageX100) / 100}x · máx pérdida $
              {formatUsdE6(BigInt(cota.maxDailyLossUsdE6)).replace("$", "")}/día
            </p>
          </Panel>

          <Panel>
            <div className="text-ink-dim font-mono text-[11px] tracking-[0.16em] uppercase">
              {t.pnl}
            </div>
            <div
              className={`mt-1 font-mono text-4xl font-bold ${net < 0n ? "text-alert" : "text-spawn"}`}
            >
              {formatUsdE6(net)}
            </div>
          </Panel>

          {halted ? (
            <Note tone="stop" title={t.halted}>
              {halted}
            </Note>
          ) : null}

          {!halted ? (
            <Panel className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {cota.markets.map((m) => (
                  <button
                    key={m}
                    onClick={() => setMarket(m)}
                    className={`min-h-11 rounded-xl border-2 px-3 font-semibold ${market === m ? "bg-phosphor text-void border-phosphor" : "border-hull-line text-ink"}`}
                  >
                    {m}{" "}
                    <span className="font-mono text-xs opacity-70">
                      {marks.has(m) ? formatUsdE6(marks.get(m)!) : "—"}
                    </span>
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                {(["long", "short"] as Side[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => setSide(s)}
                    className={`min-h-11 flex-1 rounded-xl border-2 px-3 font-semibold ${side === s ? "bg-phosphor text-void border-phosphor" : "border-hull-line text-ink"}`}
                  >
                    {s === "long" ? t.long : t.short}
                  </button>
                ))}
              </div>
              <label className="block">
                <span className="text-ink-dim font-mono text-xs uppercase">
                  {t.size}
                </span>
                <input
                  type="number"
                  value={size}
                  min={1}
                  step={10}
                  onChange={(e) => setSize(Number(e.target.value))}
                  className="border-hull-line bg-hull-2 text-ink mt-1 min-h-12 w-full rounded-xl border-2 px-3 tabular-nums"
                />
              </label>
              <label className="block">
                <span className="text-ink-dim font-mono text-xs uppercase">
                  {t.lev}
                </span>
                <input
                  type="number"
                  value={lev}
                  min={1}
                  step={0.5}
                  onChange={(e) => setLev(Number(e.target.value))}
                  className="border-hull-line bg-hull-2 text-ink mt-1 min-h-12 w-full rounded-xl border-2 px-3 tabular-nums"
                />
              </label>
              <Button onClick={onOpen} disabled={market === null}>
                {t.openBtn}
              </Button>
              {error ? <p className="text-alert text-sm">{error}</p> : null}
            </Panel>
          ) : null}

          <Panel>
            <div className="text-ink-dim font-mono text-[11px] tracking-[0.16em] uppercase">
              {t.positions}
            </div>
            {account.positions.length === 0 ? (
              <p className="text-ink-faint mt-2 text-sm">{t.none}</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {account.positions.map((p, i) => {
                  const pnl = unrealisedPnlUsdE6(p, marks.get(p.market) ?? 0n);
                  return (
                    <li
                      key={i}
                      className="border-hull-line flex items-center justify-between gap-3 border-b pb-2 last:border-0"
                    >
                      <div className="text-sm">
                        <div className="text-ink font-semibold">
                          {p.market} {p.side === "long" ? "▲" : "▼"}{" "}
                          {formatUsdE6(p.notionalUsdE6)} ·{" "}
                          {Number(p.leverageX100) / 100}x
                        </div>
                        <div
                          className={`font-mono text-xs ${pnl < 0n ? "text-alert" : "text-spawn"}`}
                        >
                          {formatUsdE6(pnl)}
                        </div>
                      </div>
                      <button
                        onClick={() => onClose(p)}
                        className="border-hull-line text-ink shrink-0 rounded-xl border px-3 py-2 text-sm"
                      >
                        {t.closeBtn}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <button
            onClick={() => setAccount(emptyAccount(new Date()))}
            className="text-ink-faint w-full text-center text-xs underline"
          >
            {t.reset}
          </button>
        </>
      ) : (
        <p className="text-ink-faint text-sm">{t.loading}</p>
      )}
    </main>
  );
}
