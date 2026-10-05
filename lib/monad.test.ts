import { describe, expect, it, afterEach } from "vitest";
import {
  MONAD_FALLBACK_RPC_URL,
  monad,
  monadRpcUrl,
  monadTransport,
} from "./monad";

const original = process.env.MONAD_RPC_URL;
afterEach(() => {
  if (original === undefined) delete process.env.MONAD_RPC_URL;
  else process.env.MONAD_RPC_URL = original;
});

describe("monadRpcUrl", () => {
  it("uses MONAD_RPC_URL when set", () => {
    // The whole point. Setting this and having it ignored is the bug: an
    // operator believes they are on a dedicated node and is still sharing a
    // rate-limited public one, with nothing to indicate it.
    process.env.MONAD_RPC_URL = "https://dedicated.example/rpc";
    expect(monadRpcUrl()).toBe("https://dedicated.example/rpc");
  });

  it("falls back to the chain's public endpoint when unset", () => {
    delete process.env.MONAD_RPC_URL;
    expect(monadRpcUrl()).toBe(monad.rpcUrls.default.http[0]);
  });

  it("falls back on an empty string rather than passing it to viem", () => {
    // http("") is not the same as http() and is worse than either.
    process.env.MONAD_RPC_URL = "";
    expect(monadRpcUrl()).toBe(monad.rpcUrls.default.http[0]);
  });

  it("is still chain 143", () => {
    expect(monad.id).toBe(143);
  });
});

describe("monadTransport", () => {
  const legs = () =>
    monadTransport()({ chain: monad }).value?.transports.map(
      (t: { value?: { url?: string } }) => t.value?.url,
    );

  it("puts a second endpoint behind the primary one", () => {
    // rpc.monad.xyz starts rejecting with HTTP 429 at about 28 req/s (measured
    // 2026-10-04: 12 of 120 and 21 of 300 concurrent reads refused). One leg
    // turns that into a failed read for whoever is holding the phone.
    delete process.env.MONAD_RPC_URL;
    expect(legs()).toEqual([
      monad.rpcUrls.default.http[0],
      MONAD_FALLBACK_RPC_URL,
    ]);
  });

  it("keeps a dedicated endpoint first when one is configured", () => {
    process.env.MONAD_RPC_URL = "https://dedicated.example/rpc";
    expect(legs()?.[0]).toBe("https://dedicated.example/rpc");
  });

  it("does not list the same endpoint twice", () => {
    process.env.MONAD_RPC_URL = MONAD_FALLBACK_RPC_URL;
    expect(legs()).toEqual([MONAD_FALLBACK_RPC_URL]);
  });

  it("never falls back to an endpoint that refuses debug_traceTransaction", () => {
    // rpc1.monad.xyz allows million-block eth_getLogs and full archive state,
    // which makes it the tempting choice, but it answers
    // debug_traceTransaction with "not available on the public rpc".
    // lib/cota/kuru-history.ts needs that trace to price a Kuru buy, because
    // the payout is native MON and emits no Transfer event. Verified against
    // mainnet 2026-10-04.
    expect(MONAD_FALLBACK_RPC_URL).not.toBe("https://rpc1.monad.xyz");
  });
});
