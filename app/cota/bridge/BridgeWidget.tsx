"use client";

import { useMemo } from "react";
import WormholeConnect, {
  config as whConfig,
} from "@wormhole-foundation/wormhole-connect";
import {
  monadBridgeManualRoute,
  getContractsForNetwork,
} from "@wormhole-foundation/wormhole-connect/monad";

// ---------------------------------------------------------------------------
// The Wormhole Connect widget, isolated in its own module.
//
// Everything that imports the Connect package lives here, and the page loads
// this module through next/dynamic with ssr:false. That keeps the widget and
// its wallet adapters out of the server render entirely — they are browser-only
// and would not survive SSR — and out of every other route's bundle.
//
// Routes: only the Monad NTT bridge route from the package's ./monad entry —
// the same routing monadbridge.com uses. AUSD is a Wormhole multi-token NTT
// asset, and this route is what actually lands it on Monad as the exact
// collateral Perpl reads. We restrict tokens to AUSD and the destination to
// Monad, so this single route covers the whole surface; no other routes apply.
// (The executor/auto-relay variant is a later UX upgrade — manual works and
// needs no relayer endpoint.)
// ---------------------------------------------------------------------------

// AUSD's chains (same canonical address across the EVM set) + Solana, plus
// Monad as the pinned destination.
const CHAINS = [
  "Ethereum",
  "Arbitrum",
  "Base",
  "Avalanche",
  "Polygon",
  "Bsc",
  "Solana",
  "Monad",
] as const;

export default function BridgeWidget({ title }: { title: string }) {
  const config = useMemo<whConfig.WormholeConnectConfig>(
    () => ({
      network: "Mainnet",
      chains: [...CHAINS],
      // Only AUSD — the one collateral Perpl accepts.
      tokens: ["AUSD"],
      routes: [
        monadBridgeManualRoute({
          contracts: getContractsForNetwork("Mainnet"),
        }),
      ],
      ui: {
        title,
        defaultInputs: {
          // Destination is always Monad; requiredChain stops the user changing
          // it. Source is left unset so they pick where they hold AUSD.
          destination: { chain: "Monad", token: "AUSD" },
          requiredChain: "Monad",
        },
      },
    }),
    [title],
  );

  return <WormholeConnect config={config} />;
}
