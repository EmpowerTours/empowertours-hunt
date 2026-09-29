"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { useAuthSlot } from "@/app/providers";
import { Note, Panel, Pill, Stat } from "@/components/ui/primitives";
import { SignInPrompt } from "@/components/auth/SignInPrompt";
import { LanguageSwitch } from "@/components/hunt/LanguageSwitch";

// ---------------------------------------------------------------------------
// Results. One question: what did my trades make.
//
// This screen exists because the app could not answer it. Four real fills
// closed at a profit in September and there was nowhere in the product to see
// them — /cota/risk reads live exposure, so a flat account renders "no
// position" and stops, and the trade screen lists what the agent DECIDED, not
// what it earned. The only honest answer available was "go and look at the
// venue's own website", which is not an answer a product that claims to hold
// your leash is allowed to give.
//
// EVERY FIGURE IS AFTER FEES. The gross number is the flattering one and on a
// trade this size the fees are most of the margin, so the headline is net and
// the fees are shown next to it rather than folded away.
//
// AN OPEN TRIP IS NOT A RESULT. While a position is open the only realised
// money is the fees already paid, so an open row shows those and says "open"
// instead of printing a profit that has not happened. The mark-to-market
// belongs on /cota/risk, which reads it from the venue.
// ---------------------------------------------------------------------------

type Lang = "es" | "en";

const T = {
  es: {
    title: "Resultados",
    lede: "Lo que han dado tus operaciones, después de comisiones.",
    back: "Cota",
    signIn: "Inicia sesión",
    empty: "Todavía no hay operaciones ejecutadas.",
    emptyNote:
      "Cuando el agente llene una orden bajo tu correa, aparecerá aquí con lo que ganó o perdió.",
    realised: "Resultado neto",
    realisedSub: "de operaciones cerradas, neto de comisiones",
    fees: "Comisiones",
    feesSub: "pagadas a la casa en total",
    trades: "Operaciones",
    tradesSub: "cerradas · abiertas",
    long: "largo",
    short: "corto",
    open: "ABIERTA",
    entry: "Entrada",
    exit: "Salida",
    size: "Tamaño",
    feeRow: "Comisión",
    net: "Neto",
    fillsIn: "llenados",
    openNote:
      "Posición abierta: lo único realizado son las comisiones. El resultado se verá al cerrar.",
    riskLink: "Ver exposición actual →",
    adopted: "sobre la hora",
    adoptedNote:
      "De algunos llenados no consta cómo llegaron al registro: se reconstruyeron comparando nuestro libro con el total de la casa. Los precios y los tamaños son correctos —cuadran con la casa— pero la hora mostrada puede ser la de la reconciliación y no la del llenado.",
    account: "Cuenta",
  },
  en: {
    title: "Results",
    lede: "What your trades made, after fees.",
    back: "Cota",
    signIn: "Sign in",
    empty: "No trades have executed yet.",
    emptyNote:
      "When the agent fills an order under your leash it appears here, with what it made or lost.",
    realised: "Net result",
    realisedSub: "on closed trades, fees already taken out",
    fees: "Fees",
    feesSub: "paid to the venue in total",
    trades: "Trades",
    tradesSub: "closed · open",
    long: "long",
    short: "short",
    open: "OPEN",
    entry: "Entry",
    exit: "Exit",
    size: "Size",
    feeRow: "Fee",
    net: "Net",
    fillsIn: "fills",
    openNote:
      "Position open: the only thing realised is the fees. The result lands when it closes.",
    riskLink: "See current exposure →",
    adopted: "about the times",
    adoptedNote:
      "Some fills have no record of how they reached the ledger: they were reconstructed by differencing our book against the venue's total. The prices and sizes are right — they reconcile against the venue — but the time shown may be when we reconciled rather than when it filled.",
    account: "Account",
  },
} as const;

/** The string table, widened off the literal types so either language fits. */
type Strings = { [K in keyof (typeof T)["en"]]: string };

interface Trip {
  market: string;
  side: "long" | "short";
  units: number;
  entryUsd: number;
  exitUsd: number | null;
  feesUsd: number;
  netUsd: number;
  netPct: number | null;
  openedAtMs: number;
  closedAtMs: number | null;
  open: boolean;
  fills: number;
}

interface Account {
  account: string;
  realisedUsd: number;
  feesUsd: number;
  closed: number;
  open: number;
  fillCount: number;
  adopted: number;
  unknownSource: number;
  trips: Trip[];
}

interface History {
  accounts: Account[];
  realisedUsd: number;
  feesUsd: number;
  fillCount: number;
}

/** Signed money, always with its sign, so a loss can never read as a gain. */
function money(v: number, dp = 4): string {
  const s = v < 0 ? "−" : "+";
  return `${s}$${Math.abs(v).toFixed(dp)}`;
}

function price(v: number): string {
  // Perp marks here are fractions of a cent; 6dp is the venue's own precision.
  return `$${v.toFixed(6)}`;
}

function when(ms: number, lang: Lang): string {
  return new Date(ms).toLocaleString(lang === "es" ? "es-MX" : "en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function TripRow({ t, lang, tr }: { t: Trip; lang: Lang; tr: Strings }) {
  const good = t.netUsd > 0;
  return (
    <div className="border-hull-line bg-hull-2/40 rounded-xl border p-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold">{t.market}</span>
          <Pill>{t.side === "long" ? tr.long : tr.short}</Pill>
          {t.open ? <Pill className="text-band-hot">{tr.open}</Pill> : null}
        </div>
        <div
          className={`font-mono text-lg leading-none ${
            t.open ? "text-ink-dim" : good ? "text-phosphor" : "text-alert"
          }`}
        >
          {money(t.netUsd)}
          {t.netPct !== null ? (
            <span className="text-ink-faint ml-1 text-xs">
              {t.netPct > 0 ? "+" : ""}
              {t.netPct.toFixed(2)}%
            </span>
          ) : null}
        </div>
      </div>

      <dl className="text-ink-dim mt-2 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-xs">
        <div className="flex justify-between">
          <dt>{tr.size}</dt>
          <dd className="text-ink">{t.units}</dd>
        </div>
        <div className="flex justify-between">
          <dt>{tr.feeRow}</dt>
          <dd className="text-ink">${t.feesUsd.toFixed(4)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>{tr.entry}</dt>
          <dd className="text-ink">{price(t.entryUsd)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>{tr.exit}</dt>
          <dd className="text-ink">
            {t.exitUsd === null ? "—" : price(t.exitUsd)}
          </dd>
        </div>
      </dl>

      <div className="text-ink-faint mt-2 text-[11px]">
        {when(t.openedAtMs, lang)}
        {t.closedAtMs !== null ? ` → ${when(t.closedAtMs, lang)}` : ""} ·{" "}
        {t.fills} {tr.fillsIn}
      </div>

      {t.open ? (
        <p className="text-ink-dim mt-2 text-xs leading-snug">{tr.openNote}</p>
      ) : null}
    </div>
  );
}

export default function HistoryPage() {
  const lang: Lang = useLocale() === "es" ? "es" : "en";
  const tr = T[lang];
  const auth = useAuthSlot();
  const [hist, setHist] = useState<History | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Fetched once per sign-in, not polled: a fill lands every few days at most,
  // and a results screen that re-requests every 8 seconds is spending the
  // hunter's battery to tell them the same thing.
  useEffect(() => {
    if (auth.status !== "signed-in") return;
    let live = true;
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/cota/history", { signal: ac.signal });
        if (!res.ok || !live) return;
        setHist((await res.json()) as History);
      } catch {
        // Keep whatever is already on screen. A dropped request is not a
        // trade disappearing, and blanking the result would say it was.
      } finally {
        if (live) setLoaded(true);
      }
    })();
    return () => {
      live = false;
      ac.abort();
    };
  }, [auth.status]);

  const anyAdopted =
    hist?.accounts.some((a) => a.adopted + a.unknownSource > 0) ?? false;

  return (
    <main className="safe-top safe-bottom text-ink mx-auto flex min-h-dvh max-w-md flex-col gap-4 px-4 py-6">
      <a href="/cota" className="text-ink-dim w-fit text-sm hover:underline">
        ← {tr.back}
      </a>
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{tr.title}</h1>
          <p className="text-ink-dim mt-1 text-sm">{tr.lede}</p>
        </div>
        <LanguageSwitch className="shrink-0" />
      </header>

      {auth.status !== "signed-in" ? (
        <Panel>
          <SignInPrompt label={tr.signIn} />
        </Panel>
      ) : !loaded || !hist ? (
        <Panel>
          <p className="text-ink-dim text-sm">…</p>
        </Panel>
      ) : hist.fillCount === 0 ? (
        <Panel>
          <p className="text-sm">{tr.empty}</p>
          <p className="text-ink-dim mt-2 text-sm leading-snug">
            {tr.emptyNote}
          </p>
        </Panel>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Stat
              label={tr.realised}
              value={money(hist.realisedUsd)}
              sub={tr.realisedSub}
              tone={hist.realisedUsd < 0 ? "warn" : "credit"}
            />
            <Stat
              label={tr.fees}
              value={`$${hist.feesUsd.toFixed(4)}`}
              sub={tr.feesSub}
            />
          </div>

          {hist.accounts.map((a) => (
            <section key={a.account} className="flex flex-col gap-2">
              {hist.accounts.length > 1 ? (
                <div className="text-ink-faint font-mono text-[11px] tracking-[0.18em] uppercase">
                  {tr.account} {a.account.slice(0, 6)}…{a.account.slice(-4)} ·{" "}
                  {a.closed} / {a.open} {tr.tradesSub}
                </div>
              ) : null}
              {a.trips.map((t) => (
                <TripRow
                  key={`${t.market}-${t.openedAtMs}`}
                  t={t}
                  lang={lang}
                  tr={tr}
                />
              ))}
            </section>
          ))}

          {anyAdopted ? <Note title={tr.adopted}>{tr.adoptedNote}</Note> : null}

          <a href="/cota/risk" className="text-ink-dim text-sm hover:underline">
            {tr.riskLink}
          </a>
        </>
      )}
    </main>
  );
}
