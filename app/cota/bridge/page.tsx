"use client";

import dynamic from "next/dynamic";
import { useLocale } from "next-intl";

// ---------------------------------------------------------------------------
// Funding a Cota account with AUSD — the bridge, embedded.
//
// Perpl settles in AUSD, and AUSD has no market on Monad (measured: ~2 AUSD
// across every DEX pool). The only way to get it is to bring it across from a
// chain where it already exists. AUSD is a Wormhole-native token at the same
// address on Ethereum, Arbitrum, Base, Avalanche, BSC, Polygon, Solana and
// Monad, so Wormhole Connect moves it straight to Monad — the exact token
// Perpl uses as collateral.
//
// Two honest limits this page states out loud:
//  - This is NOT a MON->AUSD swap. It moves AUSD you already hold on another
//    chain. A player who only has hunted MON on Monad has nothing to bridge.
//  - Destination is locked to Monad; source is the user's to pick.
//
// The widget itself is browser-only (wallet adapters, its own theme), so it is
// loaded through next/dynamic with ssr:false and only when this route opens.
// ---------------------------------------------------------------------------

const BridgeWidget = dynamic(() => import("./BridgeWidget"), {
  ssr: false,
  loading: () => (
    <p className="text-ink-dim py-10 text-center text-sm">Loading bridge…</p>
  ),
});

const T = {
  es: {
    title: "Trae AUSD a Monad",
    lead: "Perpl opera con AUSD. Este puente trae tu AUSD desde otra cadena (Ethereum, Base, Arbitrum, Solana…) directo a Monad, listo para operar.",
    notSwap:
      "Esto NO cambia MON por AUSD. Mueve AUSD que ya tienes en otra cadena. Si sólo tienes MON de la búsqueda, todavía no puedes usar este puente — usa el modo práctica.",
    widgetTitle: "Puente a Monad",
  },
  en: {
    title: "Bring AUSD to Monad",
    lead: "Perpl trades in AUSD. This bridge brings your AUSD from another chain (Ethereum, Base, Arbitrum, Solana…) straight to Monad, ready to trade.",
    notSwap:
      "This does NOT swap MON for AUSD. It moves AUSD you already hold on another chain. If you only have hunted MON, this bridge can't help yet — use practice mode.",
    widgetTitle: "Bridge to Monad",
  },
} as const;

export default function CotaBridgePage() {
  const t = T[useLocale() === "es" ? "es" : "en"];

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-5 px-5 py-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-ink text-2xl font-black tracking-tight">
          {t.title}
        </h1>
        <p className="text-ink-dim text-sm">{t.lead}</p>
        <p className="text-alert rounded-lg border border-current/20 bg-current/5 px-3 py-2 text-xs">
          {t.notSwap}
        </p>
      </header>

      <BridgeWidget title={t.widgetTitle} />
    </main>
  );
}
