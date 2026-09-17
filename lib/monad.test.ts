import { describe, expect, it, afterEach } from "vitest";
import { monad, monadRpcUrl } from "./monad";

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
