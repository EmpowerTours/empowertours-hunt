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

/**
 * The RPC endpoint every client here should use.
 *
 * `http()` with no argument silently falls back to the chain's public endpoint.
 * That is not a harmless default: an operator who sets MONAD_RPC_URL gets no
 * effect, believes they are on a dedicated node, and is still sharing a
 * rate-limited public one. lib/hunt/payout.ts hit exactly this and fixed it
 * locally; lib/cota kept the bug, which meant the agent's whole RPC surface —
 * every mark read, position read, deposit, anchor and forwarding call — ignored
 * the setting.
 *
 * One definition, so the next caller cannot reintroduce it by writing `http()`
 * out of habit.
 */
export function monadRpcUrl(): string {
  return process.env.MONAD_RPC_URL || monad.rpcUrls.default.http[0];
}
