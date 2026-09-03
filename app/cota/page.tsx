"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuthSlot } from "@/app/providers";
import { Button, Note, Panel, Pill } from "@/components/ui/primitives";
import { readback } from "@/lib/cota/readback";
import { leverageX100, LossyScaleError, usdE6 } from "@/lib/cota/scale";
import { newBrowserNonce, signCota } from "@/lib/cota/sign";
import type { CotaMessage } from "@/lib/cota/typedData";

// ---------------------------------------------------------------------------
// Signing a Cota.
//
// The screen is built around the read-back, not the form. A player agreeing to
// what software may do on their behalf needs to see the agreement in sentences
// before the Face ID prompt — the inputs are just how the sentences get their
// numbers, and they are the less important half of this page.
//
// Spanish first. The audience is Guerrero, and a financial limit read in a
// second language is a limit somebody half-understood.
// ---------------------------------------------------------------------------

type Lang = "es" | "en";

interface Market {
  market: string;
  midUsdE6: string;
}

/**
 * Defaults chosen to be small.
 *
 * A player who signs without touching anything should end up with a bound that
 * cannot hurt them. Generous defaults on a screen most people will not read
 * carefully would make the ceiling a formality.
 */
const DEFAULTS = {
  maxNotional: 50,
  maxLeverage: 2,
  maxDailyLoss: 10,
  maxTradesPerDay: 5,
  days: 30,
};

const T = {
  es: {
    title: "Firma tu Cota",
    lede: "Una Cota es el límite que le pones al software antes de que opere por ti. Tú firmas los números; nada puede pasarse de ellos.",
    signIn: "Inicia sesión para firmar",
    signInBody:
      "Necesitas tu llave de acceso (Face ID o huella) para firmar una Cota.",
    market: "Mercado",
    size: "Tamaño máximo abierto (USD)",
    leverage: "Apalancamiento máximo",
    loss: "Pérdida máxima por día (USD)",
    trades: "Operaciones por día",
    duration: "Duración (días)",
    agreement: "Lo que estás firmando",
    sign: "Firmar con Face ID",
    signing: "Firmando…",
    signed: "Cota firmada",
    signedBody: "Tu límite quedó registrado. Puedes revocarlo cuando quieras.",
    another: "Firmar otra",
    paper: "Modo práctica",
    paperBody:
      "Esto opera con precios reales de Perpl pero sin dinero. Para operar de verdad necesitas AUSD, que llega por el puente desde otra red.",
    noMarkets: "No se pudo contactar al mercado. Intenta más tarde.",
    loading: "Cargando mercados…",
    badNumber: "Revisa ese número.",
  },
  en: {
    title: "Sign your Cota",
    lede: "A Cota is the limit you put on software before it trades for you. You sign the numbers; nothing can exceed them.",
    signIn: "Sign in to sign a Cota",
    signInBody:
      "You need your passkey (Face ID or fingerprint) to sign a Cota.",
    market: "Market",
    size: "Max size open (USD)",
    leverage: "Max leverage",
    loss: "Max loss per day (USD)",
    trades: "Trades per day",
    duration: "Duration (days)",
    agreement: "What you're signing",
    sign: "Sign with Face ID",
    signing: "Signing…",
    signed: "Cota signed",
    signedBody: "Your limit is on file. You can revoke it whenever you want.",
    another: "Sign another",
    paper: "Practice mode",
    paperBody:
      "This runs on real Perpl prices with no money. Trading for real needs AUSD, which arrives by bridge from another network.",
    noMarkets: "Couldn't reach the venue. Try again later.",
    loading: "Loading markets…",
    badNumber: "Check that number.",
  },
} as const;

function Field({
  label,
  value,
  onChange,
  step = 1,
  min = 0,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  suffix?: string;
}) {
  return (
    <label className="block">
      <span className="text-ink-dim font-mono text-xs tracking-[0.14em] uppercase">
        {label}
      </span>
      <div className="mt-1.5 flex items-center gap-2">
        <input
          type="number"
          inputMode="decimal"
          value={value}
          step={step}
          min={min}
          onChange={(e) => {
            onChange(Number(e.target.value));
          }}
          className="border-hull-line bg-hull-2 text-ink min-h-14 w-full rounded-2xl border-2 px-4 text-lg tabular-nums"
        />
        {suffix ? (
          <span className="text-ink-faint w-8 shrink-0 text-lg">{suffix}</span>
        ) : null}
      </div>
    </label>
  );
}

export default function CotaPage() {
  const auth = useAuthSlot();
  const [lang, setLang] = useState<Lang>("es");
  const t = T[lang];

  const [markets, setMarkets] = useState<Market[] | null>(null);
  const [marketsFailed, setMarketsFailed] = useState(false);
  const [market, setMarket] = useState<string | null>(null);

  const [maxNotional, setMaxNotional] = useState(DEFAULTS.maxNotional);
  const [maxLeverage, setMaxLeverage] = useState(DEFAULTS.maxLeverage);
  const [maxDailyLoss, setMaxDailyLoss] = useState(DEFAULTS.maxDailyLoss);
  const [maxTrades, setMaxTrades] = useState(DEFAULTS.maxTradesPerDay);
  const [days, setDays] = useState(DEFAULTS.days);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedDigest, setSignedDigest] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/cota/markets");
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { markets: Market[] };
        if (!live) return;
        setMarkets(body.markets);
        setMarket((m) => m ?? body.markets[0]?.market ?? null);
      } catch {
        if (live) setMarketsFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  /**
   * The ceilings, and nothing that depends on a clock.
   *
   * Returns null when any field cannot be represented exactly — scale.ts throws
   * rather than rounding, and a ceiling that was quietly rounded is a ceiling
   * nobody agreed to. The sign button stays disabled instead.
   */
  const ceilings = useMemo(() => {
    if (market === null) return null;
    try {
      return {
        venue: "perpl" as const,
        markets: [market],
        maxNotionalUsdE6: usdE6(maxNotional, "maxNotional"),
        maxLeverageX100: leverageX100(maxLeverage, "maxLeverage"),
        maxDailyLossUsdE6: usdE6(maxDailyLoss, "maxDailyLoss"),
        maxTradesPerDay: Math.floor(maxTrades),
      };
    } catch (err) {
      if (err instanceof LossyScaleError) return null;
      throw err;
    }
  }, [market, maxNotional, maxLeverage, maxDailyLoss, maxTrades]);

  const durationDays = Math.max(1, Math.floor(days));
  const durationSeconds = BigInt(durationDays) * 86_400n;

  /**
   * The expiry reads as a duration, not a date.
   *
   * Before a signature exists there is no absolute date to show: the window
   * starts when the player signs. A date computed at page load would print a
   * promise slightly different from the one actually signed.
   */
  const lines = useMemo(
    () =>
      ceilings
        ? readback(ceilings, { kind: "afterSigning", days: durationDays })
        : [],
    [ceilings, durationDays],
  );

  const onSign = useCallback(async () => {
    if (ceilings === null) return;
    setBusy(true);
    setError(null);
    try {
      // Clock and nonce read HERE, not during render: clientTs must be inside
      // the skew window when the signature is made, and the nonce is
      // single-use per signature.
      const now = BigInt(Math.floor(Date.now() / 1000));
      const message: CotaMessage = {
        ...ceilings,
        notBefore: now,
        notAfter: now + durationSeconds,
        clientTs: now,
        nonce: newBrowserNonce(),
      };
      const signature = await signCota(message);
      const res = await fetch("/api/cota", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          venue: message.venue,
          markets: message.markets,
          maxNotionalUsdE6: message.maxNotionalUsdE6.toString(),
          maxLeverageX100: message.maxLeverageX100.toString(),
          maxDailyLossUsdE6: message.maxDailyLossUsdE6.toString(),
          maxTradesPerDay: message.maxTradesPerDay,
          notBefore: message.notBefore.toString(),
          notAfter: message.notAfter.toString(),
          clientTs: message.clientTs.toString(),
          nonce: message.nonce,
          signature,
        }),
      });
      const body = (await res.json()) as {
        cota?: { digest: string };
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? String(res.status));
      setSignedDigest(body.cota?.digest ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      setBusy(false);
    }
  }, [ceilings, durationSeconds]);

  return (
    <main className="mx-auto w-full max-w-lg space-y-4 p-4 pb-24">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-ink text-2xl font-semibold">{t.title}</h1>
          <p className="text-ink-dim mt-1 text-sm leading-snug">{t.lede}</p>
        </div>
        <button
          onClick={() => {
            setLang((l) => (l === "es" ? "en" : "es"));
          }}
          className="border-hull-line text-ink-dim shrink-0 rounded-full border px-3 py-1 font-mono text-xs"
        >
          {lang === "es" ? "EN" : "ES"}
        </button>
      </header>

      <Note tone="info" title={t.paper}>
        {t.paperBody}
      </Note>

      {auth.status !== "signed-in" ? (
        <Panel className="space-y-3">
          <p className="text-ink text-sm">{t.signInBody}</p>
          <Button
            onClick={() => {
              void auth.signIn();
            }}
            disabled={!auth.canSignIn}
          >
            {t.signIn}
          </Button>
        </Panel>
      ) : signedDigest !== null ? (
        <Panel className="space-y-3">
          <Pill color="#4ade80">{t.signed}</Pill>
          <p className="text-ink text-sm">{t.signedBody}</p>
          <p className="text-ink-faint font-mono text-[11px] break-all">
            {signedDigest}
          </p>
          <Button
            tone="ghost"
            onClick={() => {
              setSignedDigest(null);
            }}
          >
            {t.another}
          </Button>
        </Panel>
      ) : (
        <>
          <Panel className="space-y-4">
            <div>
              <span className="text-ink-dim font-mono text-xs tracking-[0.14em] uppercase">
                {t.market}
              </span>
              {marketsFailed ? (
                <p className="text-alert mt-2 text-sm">{t.noMarkets}</p>
              ) : markets === null ? (
                <p className="text-ink-faint mt-2 text-sm">{t.loading}</p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  {markets.map((m) => (
                    <button
                      key={m.market}
                      onClick={() => {
                        setMarket(m.market);
                      }}
                      className={`min-h-12 rounded-2xl border-2 px-4 font-semibold ${
                        market === m.market
                          ? "bg-phosphor text-void border-phosphor"
                          : "border-hull-line text-ink"
                      }`}
                    >
                      {m.market}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <Field
              label={t.size}
              value={maxNotional}
              onChange={setMaxNotional}
              step={10}
              suffix="$"
            />
            <Field
              label={t.leverage}
              value={maxLeverage}
              onChange={setMaxLeverage}
              step={0.5}
              min={1}
              suffix="x"
            />
            <Field
              label={t.loss}
              value={maxDailyLoss}
              onChange={setMaxDailyLoss}
              step={5}
              suffix="$"
            />
            <Field
              label={t.trades}
              value={maxTrades}
              onChange={setMaxTrades}
              step={1}
            />
            <Field
              label={t.duration}
              value={days}
              onChange={setDays}
              step={1}
              min={1}
            />
          </Panel>

          <Panel className="space-y-3">
            <h2 className="text-ink-dim font-mono text-xs tracking-[0.14em] uppercase">
              {t.agreement}
            </h2>
            {ceilings === null ? (
              <p className="text-alert text-sm">{t.badNumber}</p>
            ) : (
              <ul className="space-y-2.5">
                {/* Protective clauses first: what bounds the loss is what the
                    player is actually protected by, and a limit buried under a
                    venue name is a disclosure nobody read. */}
                {[...lines]
                  .sort((a, b) => Number(b.protective) - Number(a.protective))
                  .map((line) => (
                    <li
                      key={line.id}
                      className={`border-l-2 pl-3 text-sm leading-snug ${
                        line.protective
                          ? "border-phosphor text-ink"
                          : "border-hull-line text-ink-dim"
                      }`}
                    >
                      {line[lang]}
                    </li>
                  ))}
              </ul>
            )}
          </Panel>

          {error !== null ? (
            <Note tone="stop" title="Error">
              {error}
            </Note>
          ) : null}

          <Button
            onClick={() => void onSign()}
            disabled={busy || ceilings === null}
          >
            {busy ? t.signing : t.sign}
          </Button>
        </>
      )}
    </main>
  );
}
