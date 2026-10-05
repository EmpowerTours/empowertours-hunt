import { describe, expect, it } from "vitest";
import { createPublicClient } from "viem";
import { monad, monadTransport } from "./monad";

// Real mainnet reads through the exact transport production uses. Off by
// default: it needs the network, so it has no business failing a unit run.
//
//   LIVE_RPC=1 npx vitest run lib/monad.livecheck.test.ts
const KURU_TX =
  "0x56a1c47b8992813c8dbce4061ee05762afa42fd281bf25c6272251c22fe69e82";

describe.skipIf(!process.env.LIVE_RPC)("monadTransport against mainnet", () => {
  // cacheTime 0, or viem answers a repeated eth_blockNumber from cache and the
  // burst below becomes one request pretending to be sixty.
  const client = createPublicClient({
    chain: monad,
    transport: monadTransport(),
    cacheTime: 0,
  });

  it("reads the chain id through the fallback", async () => {
    expect(await client.getChainId()).toBe(143);
  }, 60_000);

  it("serves a receipt for a real Kuru entrypoint tx", async () => {
    const r = await client.getTransactionReceipt({ hash: KURU_TX });
    expect(r.status).toBe("success");
  }, 60_000);

  it("still answers debug_traceTransaction, which Cota's P&L needs", async () => {
    const trace = await client.request({
      method: "debug_traceTransaction",
      params: [KURU_TX, { tracer: "callTracer" }],
    } as never);
    expect(trace).toBeTruthy();
  }, 90_000);

  it("survives a burst that makes the bare public endpoint shed requests", async () => {
    // 60 reads of 60 DIFFERENT addresses, so viem cannot dedupe or cache them
    // into one call. On rpc.monad.xyz alone a large share come back 429;
    // through the fallback every one of them must resolve.
    const addresses = Array.from(
      { length: 60 },
      (_, i) =>
        `0x${(BigInt("0x1000000000000000000000000000000000000000") + BigInt(i))
          .toString(16)
          .padStart(40, "0")}` as `0x${string}`,
    );
    const out = await Promise.all(
      addresses.map((address) => client.getBalance({ address })),
    );
    expect(out).toHaveLength(60);
    expect(out.every((b) => typeof b === "bigint")).toBe(true);
  }, 120_000);
});
