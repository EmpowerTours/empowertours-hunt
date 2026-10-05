import { defineChain, fallback, http } from "viem";

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

/**
 * The resilient second leg of the transport.
 *
 * Measured against mainnet on 2026-10-04, not assumed:
 *
 *   endpoint                 getLogs span  archive   debug_trace  seq latency
 *   rpc.monad.xyz (default)           100  ~1.2M blk  yes          137 ms
 *   rpc1.monad.xyz (Alchemy)        >=1M   full       NO           146 ms
 *   rpc2.monad.xyz                  ~25k   full       yes          307 ms
 *
 * `rpc.monad.xyz` starts returning HTTP 429 at roughly 28 req/s — 12 of 120
 * and 21 of 300 concurrent reads were rejected. viem retries a 429 three times
 * (`node_modules/viem/utils/buildRequest.ts`), which hides it at low load and
 * surfaces it as a failed read under sustained load. `rpc2.monad.xyz` took
 * 300 of 300 with no 429.
 *
 * rpc1 is deliberately NOT used: it refuses `debug_traceTransaction`, which
 * lib/cota/kuru-history.ts needs to price a Kuru buy (native MON emits no
 * Transfer event). rpc2 keeps it, and serves receipts and traces for
 * transactions at least 278 days old.
 *
 * It is the second leg rather than the first because it costs ~170 ms more per
 * call, and every Hunt read is on a latency-sensitive path.
 */
export const MONAD_FALLBACK_RPC_URL = "https://rpc2.monad.xyz";

/**
 * The transport every client here should use.
 *
 * viem's `fallback` moves to the next transport on any error its default
 * `shouldThrow` does not claim, and that list is only user-rejection and
 * execution-reverted — so a 429 falls through to the resilient endpoint while a
 * genuine revert still fails immediately instead of being re-sent.
 *
 * Prefer this over a bare `http(monadRpcUrl())`, which has one leg, so a
 * rate-limited public endpoint becomes a user-visible failure.
 */
export function monadTransport() {
  const primary = monadRpcUrl();
  // Always a fallback, even with one leg: a concrete return type keeps viem's
  // client generics intact, which a widened `Transport` annotation erases.
  return primary === MONAD_FALLBACK_RPC_URL
    ? fallback([http(primary)])
    : fallback([http(primary), http(MONAD_FALLBACK_RPC_URL)]);
}
