"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { useAuthSlot } from "@/app/providers";
import { Button, Note, Panel } from "@/components/ui/primitives";
import { LanguageSwitch } from "@/components/hunt/LanguageSwitch";

// ---------------------------------------------------------------------------
// The risk screen. One question: how exposed am I, right now, in numbers I can
// act on.
//
// Two decisions shape it.
//
// It leads with what a close WOULD REALISE, not unrealised PnL against the mark.
// A hunter cannot sell at the mark — they sell into the bid, having already paid
// fees, and paying one more to leave. On MON that gap is ~30 bps, which is the
// width of the band where a position reads green and pays out red. Leading with
// the mark number would be the prettier lie.
//
// It shows no liquidation price. Perpl's own docs give the margin fractions in
// contradictory units, and the wrong reading errs toward telling somebody they
// are safe. The panel says that plainly instead of drawing a number that might
// be four times wrong in the comforting direction.
// ---------------------------------------------------------------------------

type Lang = "es" | "en";

const T = {
  es: {
    title: "Riesgo",
    lede: "Tu exposición ahora mismo, leída de la casa.",
    signIn: "Inicia sesión",
    none: "Sin correa activa. Firma una Cota para empezar.",
    flat: "Sin posición abierta.",
    closeNow: "Si cierras ahora",
    closeNote:
      "Neto: precio de salida real, menos comisiones pagadas y la de cerrar.",
    markPnl: "Contra el precio medio",
    markNote: "Lo que muestran otros paneles. No es lo que recibes.",
    position: "Posición",
    entry: "Entrada",
    mark: "Precio",
    exitAt: "Saldrías a",
    leashUse: "Uso de la correa",
    notional: "Nocional abierto",
    trades: "Operaciones hoy",
    loss: "Pérdida hoy",
    lossUnknown: "No verificable — la correa rechaza abrir",
    venue: "Cuenta en Perpl",
    forwarding: "Reenvío de órdenes",
    on: "activo",
    off: "APAGADO",
    free: "Colateral libre",
    agent: "Agente",
    agentOff: "apagado",
    noLiq: "Sin precio de liquidación",
    back: "Cota",
  },
  en: {
    title: "Risk",
    lede: "Your exposure right now, read from the venue.",
    signIn: "Sign in",
    none: "No active leash. Sign a Cota to begin.",
    flat: "No open position.",
    closeNow: "If you close now",
    closeNote: "Net: the real exit price, less fees paid and the fee to close.",
    markPnl: "Against the mark",
    markNote: "What other dashboards show. It is not what you receive.",
    position: "Position",
    entry: "Entry",
    mark: "Mark",
    exitAt: "You would exit at",
    leashUse: "Leash used",
    notional: "Open notional",
    trades: "Trades today",
    loss: "Loss today",
    lossUnknown: "Not verifiable — the leash is refusing opens",
    venue: "Perpl account",
    forwarding: "Order forwarding",
    on: "on",
    off: "OFF",
    free: "Free collateral",
    agent: "Agent",
    agentOff: "off",
    noLiq: "No liquidation price",
    back: "Cota",
  },
} as const;

interface Risk {
  market?: string;
  markUsd?: number;
  leash: {
    digest: string;
    maxNotionalUsd: number;
    maxLeverageX: number;
    maxDailyLossUsd: number;
    maxTradesPerDay: number;
  } | null;
  used?: {
    openNotionalUsd: number | null;
    tradesToday: number | null;
    lossTodayUsd: number | null;
    lossVerifiable: boolean;
  };
  position?: {
    side: string;
    sizeUnits: number;
    entryUsd: number | null;
    leverageX: number;
    exitPriceUsd: number | null;
    notionalUsd: number;
    markPnlUsd: number | null;
    closeNowUsd: number | null;
    closeNowBps: number | null;
  } | null;
  venue?: {
    accountId: number;
    forwardingAllowed: boolean;
    availableUsd: number;
  } | null;
  agent?: {
    mode: string;
    recent: { id: string; act: string; why: string; at: string }[];
  };
  omitted?: { liquidationPrice: string };
}

function Bar({ used, cap }: { used: number | null; cap: number }) {
  // An unknown is not a zero. A bar drawn at 0% for a number we could not read
  // says "plenty of room" when the truth is "we don't know".
  if (used === null) {
    return <div className="bg-alert/30 h-1.5 w-full rounded-full" />;
  }
  const pct = cap <= 0 ? 0 : Math.min(100, (used / cap) * 100);
  return (
    <div className="bg-hull-line h-1.5 w-full overflow-hidden rounded-full">
      <div
        className={pct > 90 ? "bg-alert h-full" : "bg-phosphor h-full"}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export default function RiskPage() {
  const lang: Lang = useLocale() === "es" ? "es" : "en";
  const t = T[lang];
  const auth = useAuthSlot();
  const [risk, setRisk] = useState<Risk | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/cota/risk");
      if (!res.ok) return;
      setRisk((await res.json()) as Risk);
    } catch {
      // Keep the last reading. Blanking the screen on a dropped request tells a
      // hunter their exposure is gone, which is the worst thing this page could
      // say untruthfully.
    }
  }, []);

  useEffect(() => {
    let live = true;
    const tick = () => {
      if (live) void refresh();
    };
    tick();
    const id = setInterval(tick, 8000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [refresh]);

  const p = risk?.position ?? null;
  const usd = (v: number | null | undefined, dp = 4) =>
    v === null || v === undefined ? "—" : v.toFixed(dp);

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
        <Panel>
          <Button onClick={() => void auth.signIn()} disabled={!auth.canSignIn}>
            {t.signIn}
          </Button>
        </Panel>
      ) : risk && risk.leash === null ? (
        <Panel>
          <p className="text-ink-dim text-sm">{t.none}</p>
        </Panel>
      ) : (
        <>
          <Panel className="space-y-3">
            <p className="text-ink-dim text-xs tracking-wide uppercase">
              {t.closeNow}
            </p>
            {p === null ? (
              <p className="text-ink-faint text-sm">{t.flat}</p>
            ) : (
              <>
                <p
                  className={`font-mono text-3xl font-bold ${
                    (p.closeNowUsd ?? 0) >= 0 ? "text-[#4ade80]" : "text-alert"
                  }`}
                >
                  {p.closeNowUsd === null
                    ? "—"
                    : `${p.closeNowUsd >= 0 ? "+" : ""}${usd(p.closeNowUsd)}`}
                  <span className="text-ink-dim ml-2 text-base font-normal">
                    {p.closeNowBps === null
                      ? ""
                      : `${p.closeNowBps >= 0 ? "+" : ""}${p.closeNowBps.toFixed(0)} bps`}
                  </span>
                </p>
                <p className="text-ink-faint text-xs">{t.closeNote}</p>
                <div className="border-hull-line text-ink-dim border-t pt-2 text-xs">
                  <div className="flex justify-between">
                    <span>{t.markPnl}</span>
                    <span className="font-mono">
                      {p.markPnlUsd === null
                        ? "—"
                        : `${p.markPnlUsd >= 0 ? "+" : ""}${usd(p.markPnlUsd)}`}
                    </span>
                  </div>
                  <p className="text-ink-faint mt-1">{t.markNote}</p>
                </div>
              </>
            )}
          </Panel>

          {p && (
            <Panel className="space-y-1">
              <p className="text-ink-dim text-xs tracking-wide uppercase">
                {t.position}
              </p>
              <div className="text-ink flex justify-between font-semibold">
                <span>
                  {p.side} {p.sizeUnits} {risk?.market}
                </span>
                <span className="font-mono text-sm">{p.leverageX}x</span>
              </div>
              {(
                [
                  [t.entry, usd(p.entryUsd, 6)],
                  [t.mark, usd(risk?.markUsd, 6)],
                  [t.exitAt, usd(p.exitPriceUsd, 6)],
                ] as const
              ).map(([k, v]) => (
                <div
                  key={k}
                  className="text-ink-dim flex justify-between text-xs"
                >
                  <span>{k}</span>
                  <span className="font-mono">{v}</span>
                </div>
              ))}
            </Panel>
          )}

          <Panel className="space-y-3">
            <p className="text-ink-dim text-xs tracking-wide uppercase">
              {t.leashUse}
            </p>
            {risk?.leash && (
              <>
                <div className="space-y-1">
                  <div className="text-ink-dim flex justify-between text-xs">
                    <span>{t.notional}</span>
                    <span className="font-mono">
                      {usd(risk.used?.openNotionalUsd, 2)} /{" "}
                      {risk.leash.maxNotionalUsd}
                    </span>
                  </div>
                  <Bar
                    used={risk.used?.openNotionalUsd ?? null}
                    cap={risk.leash.maxNotionalUsd}
                  />
                </div>
                <div className="space-y-1">
                  <div className="text-ink-dim flex justify-between text-xs">
                    <span>{t.trades}</span>
                    <span className="font-mono">
                      {risk.used?.tradesToday ?? "—"} /{" "}
                      {risk.leash.maxTradesPerDay}
                    </span>
                  </div>
                  <Bar
                    used={risk.used?.tradesToday ?? null}
                    cap={risk.leash.maxTradesPerDay}
                  />
                </div>
                <div className="space-y-1">
                  <div className="text-ink-dim flex justify-between text-xs">
                    <span>{t.loss}</span>
                    <span className="font-mono">
                      {risk.used?.lossVerifiable
                        ? `${usd(risk.used?.lossTodayUsd, 4)} / ${risk.leash.maxDailyLossUsd}`
                        : "—"}
                    </span>
                  </div>
                  <Bar
                    used={
                      risk.used?.lossVerifiable
                        ? (risk.used?.lossTodayUsd ?? 0)
                        : null
                    }
                    cap={risk.leash.maxDailyLossUsd}
                  />
                  {risk.used && !risk.used.lossVerifiable && (
                    <p className="text-alert text-xs">{t.lossUnknown}</p>
                  )}
                </div>
              </>
            )}
          </Panel>

          {risk?.venue && (
            <Panel className="space-y-1">
              <p className="text-ink-dim text-xs tracking-wide uppercase">
                {t.venue} · {risk.venue.accountId}
              </p>
              <div className="text-ink-dim flex justify-between text-xs">
                <span>{t.forwarding}</span>
                <span
                  className={
                    risk.venue.forwardingAllowed
                      ? "text-[#4ade80] font-mono"
                      : "text-alert font-mono font-bold"
                  }
                >
                  {risk.venue.forwardingAllowed ? t.on : t.off}
                </span>
              </div>
              <div className="text-ink-dim flex justify-between text-xs">
                <span>{t.free}</span>
                <span className="font-mono">
                  {usd(risk.venue.availableUsd, 4)}
                </span>
              </div>
              <div className="text-ink-dim flex justify-between text-xs">
                <span>{t.agent}</span>
                <span className="font-mono">
                  {risk.agent?.mode === "off" ? t.agentOff : risk.agent?.mode}
                </span>
              </div>
            </Panel>
          )}

          {risk?.omitted && (
            <Note tone="info">
              <span className="font-semibold">{t.noLiq}</span> —{" "}
              {risk.omitted.liquidationPrice}
            </Note>
          )}
        </>
      )}
    </main>
  );
}
