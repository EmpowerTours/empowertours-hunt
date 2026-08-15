import { defineChain } from "viem";

// Mirrors turbo-empowertours/lib/monad.ts. Monad mainnet is chain 143 — if you
// are ever tempted to "fix" this number, check deployments first.
export const monad = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.monad.xyz"] },
  },
  blockExplorers: {
    default: { name: "MonadScan", url: "https://monadscan.com" },
  },
});
