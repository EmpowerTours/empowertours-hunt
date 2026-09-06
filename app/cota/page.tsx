"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useAuthSlot } from "@/app/providers";
import { LanguageSwitch } from "@/components/hunt/LanguageSwitch";
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
// before the passkey prompt — the inputs are just how the sentences get their
// numbers, and they are the less important half of this page.
//
// Spanish first. The audience is Guerrero, and a financial limit read in a
// second language is a limit somebody half-understood.
// ---------------------------------------------------------------------------

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
  const t = useTranslations("cota");
  // The read-back carries both languages per line; the active locale picks one.
  const lang = useLocale() === "es" ? "es" : "en";

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
  // Practice vs live, chosen UP FRONT. Both sign the same leash; this only
  // decides where the leash is used — a funded account shouldn't have to sign,
  // then dig past practice to find the live door.
  const [mode, setMode] = useState<"practice" | "live">("practice");

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
          <h1 className="text-ink text-2xl font-semibold">{t("title")}</h1>
          <p className="text-ink-dim mt-1 text-sm leading-snug">{t("lede")}</p>
        </div>
        <LanguageSwitch className="shrink-0" />
      </header>

      {/* The choice, up front — not buried behind signing. */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setMode("practice")}
          className={`flex min-h-16 flex-col items-center justify-center rounded-2xl border-2 px-3 transition-colors ${
            mode === "practice"
              ? "border-phosphor bg-phosphor/10 text-ink"
              : "border-hull-line text-ink-dim"
          }`}
        >
          <span className="text-base font-semibold">
            {lang === "es" ? "Práctica" : "Practice"}
          </span>
          <span className="text-xs">{lang === "es" ? "gratis" : "free"}</span>
        </button>
        <button
          type="button"
          onClick={() => setMode("live")}
          className={`flex min-h-16 flex-col items-center justify-center rounded-2xl border-2 px-3 transition-colors ${
            mode === "live"
              ? "border-phosphor bg-phosphor/10 text-ink"
              : "border-hull-line text-ink-dim"
          }`}
        >
          <span className="text-base font-semibold">
            {lang === "es" ? "En vivo" : "Trade live"}
          </span>
          <span className="text-xs">
            {lang === "es" ? "con AUSD" : "needs AUSD"}
          </span>
        </button>
      </div>
      <Note tone={mode === "live" ? "warn" : "info"}>
        {mode === "live"
          ? lang === "es"
            ? "Opera AUSD real en Perpl bajo tu correa firmada. Necesitas una cuenta Perpl ya fondeada con AUSD."
            : "Trade real AUSD on Perpl under your signed leash. Needs a Perpl account already funded with AUSD."
          : lang === "es"
            ? "Practica con dinero de mentira. No necesitas cripto ni AUSD."
            : "Practice with fake money — no crypto or AUSD needed."}
      </Note>

      {/* The live path needs AUSD; there are two ways to get it, by where your
          money already is. Surfaced here so neither route is orphaned. */}
      {mode === "live" && (
        <div className="grid gap-2">
          <a
            href="/cota/swap"
            className="border-hull-line text-ink flex min-h-12 w-full items-center justify-center rounded-2xl border px-5 text-sm font-medium"
          >
            {lang === "es"
              ? "Cambiar MON cazado → AUSD →"
              : "Swap hunted MON → AUSD →"}
          </a>
          <a
            href="/cota/bridge"
            className="border-hull-line text-ink flex min-h-12 w-full items-center justify-center rounded-2xl border px-5 text-sm font-medium"
          >
            {lang === "es"
              ? "Traer AUSD de otra red (puente) →"
              : "Bring AUSD from another chain →"}
          </a>
        </div>
      )}

      {auth.status !== "signed-in" ? (
        <Panel className="space-y-3">
          <p className="text-ink text-sm">{t("signInBody")}</p>
          <Button
            onClick={() => {
              void auth.signIn();
            }}
            disabled={!auth.canSignIn}
          >
            {t("signIn")}
          </Button>
        </Panel>
      ) : signedDigest !== null ? (
        <Panel className="space-y-3">
          <Pill color="#4ade80">{t("signed")}</Pill>
          <p className="text-ink text-sm">{t("signedBody")}</p>
          <p className="text-ink-faint font-mono text-[11px] break-all">
            {signedDigest}
          </p>
          <Button
            tone="ghost"
            onClick={() => {
              setSignedDigest(null);
            }}
          >
            {t("another")}
          </Button>
          {/* The primary CTA follows the mode chosen up top — live users get the
              live door, not a practice button they have to look past. */}
          {mode === "live" ? (
            <>
              <a
                href="/cota/enroll"
                className="bg-phosphor text-void flex min-h-14 w-full items-center justify-center rounded-2xl px-5 text-lg font-semibold"
              >
                {lang === "es" ? "Operar en vivo →" : "Trade live →"}
              </a>
              <a
                href="/cota/practice"
                className="border-hull-line text-ink-dim flex min-h-12 w-full items-center justify-center rounded-2xl border px-5 text-sm"
              >
                {lang === "es" ? "O practica primero" : "Or practice first"}
              </a>
            </>
          ) : (
            <>
              <a
                href="/cota/practice"
                className="bg-phosphor text-void flex min-h-14 w-full items-center justify-center rounded-2xl px-5 text-lg font-semibold"
              >
                {t("practice")}
              </a>
              <a
                href="/cota/enroll"
                className="border-hull-line text-ink flex min-h-12 w-full items-center justify-center rounded-2xl border px-5 text-sm"
              >
                {lang === "es" ? "Operar en vivo →" : "Trade live →"}
              </a>
            </>
          )}
          <p className="text-ink-faint text-center text-xs">
            {lang === "es"
              ? "En vivo es para cuentas ya fondeadas con AUSD en Perpl. ¿Nuevo? Usa práctica."
              : "Live is for accounts already funded with AUSD on Perpl. New? Use practice."}
          </p>
        </Panel>
      ) : (
        <>
          <Panel className="space-y-4">
            <div>
              <span className="text-ink-dim font-mono text-xs tracking-[0.14em] uppercase">
                {t("market")}
              </span>
              {marketsFailed ? (
                <p className="text-alert mt-2 text-sm">{t("noMarkets")}</p>
              ) : markets === null ? (
                <p className="text-ink-faint mt-2 text-sm">{t("loading")}</p>
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
              label={t("size")}
              value={maxNotional}
              onChange={setMaxNotional}
              step={10}
              suffix="$"
            />
            <Field
              label={t("leverage")}
              value={maxLeverage}
              onChange={setMaxLeverage}
              step={0.5}
              min={1}
              suffix="x"
            />
            <Field
              label={t("loss")}
              value={maxDailyLoss}
              onChange={setMaxDailyLoss}
              step={5}
              suffix="$"
            />
            <Field
              label={t("trades")}
              value={maxTrades}
              onChange={setMaxTrades}
              step={1}
            />
            <Field
              label={t("duration")}
              value={days}
              onChange={setDays}
              step={1}
              min={1}
            />
          </Panel>

          <Panel className="space-y-3">
            <h2 className="text-ink-dim font-mono text-xs tracking-[0.14em] uppercase">
              {t("agreement")}
            </h2>
            {ceilings === null ? (
              <p className="text-alert text-sm">{t("badNumber")}</p>
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
            <Note tone="stop" title={t("error")}>
              {error}
            </Note>
          ) : null}

          <Button
            onClick={() => void onSign()}
            disabled={busy || ceilings === null}
          >
            {busy ? t("signing") : t("sign")}
          </Button>
        </>
      )}
    </main>
  );
}
