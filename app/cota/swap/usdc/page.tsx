"use client";

import { useLocale } from "next-intl";
import { Note, Panel } from "@/components/ui/primitives";
import { LanguageSwitch } from "@/components/hunt/LanguageSwitch";

// ---------------------------------------------------------------------------
// USDC -> AUSD, after Kuru's relaunch.
//
// This page used to convert USDC straight to AUSD through ws.kuru.io's router.
// That API stopped answering on 2026-10-30, and Kuru's relaunched exchange has
// no AUSD market at all — all nine of its books quote USDC (2026-10-31). So
// there is no one-step route left, and pretending otherwise would leave a
// hunter signing for something that cannot fill.
//
// The route that exists is two screens the app already has: buy MON with the
// USDC on Kuru's book (/cota/spot), then MON -> AUSD on the desk (/cota/swap,
// 1% fee). Links into this page (onramp, one-click, the /cota home) keep
// working and land here, where the hunter is told that plainly.
// ---------------------------------------------------------------------------

const COPY = {
  es: {
    back: "Volver",
    title: "USDC → AUSD",
    lede: "Kuru ya no tiene un mercado de AUSD, así que no hay conversión directa. Se hace en dos pasos:",
    step1: "Compra MON con tu USDC en el libro de Kuru",
    step1Cta: "Ir a Contado →",
    step2: "Cambia ese MON por AUSD en la caja de Cota (comisión 1%)",
    step2Cta: "Ir a Cambiar →",
    why: "Tu USDC sigue en tu cartera. Nada se movió por abrir esta página.",
  },
  en: {
    back: "Back",
    title: "USDC → AUSD",
    lede: "Kuru no longer has an AUSD market, so there is no direct conversion. It takes two steps:",
    step1: "Buy MON with your USDC on Kuru's order book",
    step1Cta: "Go to Spot →",
    step2: "Swap that MON for AUSD on Cota's desk (1% fee)",
    step2Cta: "Go to Swap →",
    why: "Your USDC is still in your wallet. Opening this page moved nothing.",
  },
} as const;

export default function UsdcToAusdPage() {
  const lang = useLocale() === "es" ? "es" : "en";
  const t = COPY[lang];
  return (
    <main className="safe-top safe-bottom text-ink mx-auto flex min-h-dvh max-w-md flex-col gap-4 px-4 py-6">
      <a href="/cota" className="text-ink-dim w-fit text-sm hover:underline">
        ← {t.back}
      </a>
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t.title}</h1>
          <p className="text-ink-dim mt-1 text-sm">{t.lede}</p>
        </div>
        <LanguageSwitch />
      </header>
      <Panel className="space-y-4">
        <div>
          <p className="text-ink text-sm">1. {t.step1}</p>
          <a
            href="/cota/spot"
            className="text-phosphor text-sm font-semibold underline"
          >
            {t.step1Cta}
          </a>
        </div>
        <div>
          <p className="text-ink text-sm">2. {t.step2}</p>
          <a
            href="/cota/swap"
            className="text-phosphor text-sm font-semibold underline"
          >
            {t.step2Cta}
          </a>
        </div>
      </Panel>
      <Note>{t.why}</Note>
    </main>
  );
}
