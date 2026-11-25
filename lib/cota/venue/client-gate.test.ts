import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A socket that records that it was opened, then fails at once. Opening it at
// all is what the backstop must prevent for an opening order.
const opened: string[] = [];
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeSocket extends EventEmitter {
    constructor(url: string) {
      super();
      opened.push(url);
      setTimeout(() => this.emit("error", new Error("no network in tests")), 0);
    }
    send() {}
    close() {}
    terminate() {}
  }
  return { default: FakeSocket };
});

import { isReducingOrderType, placeOrder } from "./client";
import {
  MON_MARKET,
  T_CLOSE_LONG,
  T_CLOSE_SHORT,
  T_OPEN_LONG,
  T_OPEN_SHORT,
} from "../order";

const FOUNDER = "0x52908400098527886e0f7030069857d2e4169ee7";
const OTHER = "0xde709f2102306220921060314715629080e2fb77";

function args(orderType: number, ownerWallet: string) {
  return {
    ownerWallet,
    apiKey: "test-api-key",
    secretHex: "00".repeat(32),
    market: MON_MARKET,
    orderType,
    sizeUnits: 1,
    leverageX: 1,
    feeBps: 0,
    timeoutMs: 1_000,
  };
}

describe("placeOrder real-money backstop", () => {
  const prev = process.env.COTA_REAL_MONEY_ALLOWLIST;
  beforeEach(() => {
    opened.length = 0;
    process.env.COTA_REAL_MONEY_ALLOWLIST = FOUNDER;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.COTA_REAL_MONEY_ALLOWLIST;
    else process.env.COTA_REAL_MONEY_ALLOWLIST = prev;
  });

  it("only close types count as reducing; unknown types are gated", () => {
    expect(isReducingOrderType(T_CLOSE_LONG)).toBe(true);
    expect(isReducingOrderType(T_CLOSE_SHORT)).toBe(true);
    expect(isReducingOrderType(T_OPEN_LONG)).toBe(false);
    expect(isReducingOrderType(T_OPEN_SHORT)).toBe(false);
    expect(isReducingOrderType(99)).toBe(false);
  });

  it.each([T_OPEN_LONG, T_OPEN_SHORT, 99])(
    "refuses opening type %i for a wallet not on the list, without a socket",
    async (t) => {
      const r = await placeOrder(args(t, OTHER));
      expect(r.sentToVenue).toBe(false);
      expect(r.accepted).toBe(false);
      expect(r.error).toBe("Real-money trading is closed for now.");
      expect(opened).toHaveLength(0);
    },
  );

  it("refuses an open for everyone when the list is empty", async () => {
    process.env.COTA_REAL_MONEY_ALLOWLIST = "";
    const r = await placeOrder(args(T_OPEN_LONG, FOUNDER));
    expect(r.sentToVenue).toBe(false);
    expect(opened).toHaveLength(0);
  });

  it("lets an allowlisted wallet's open reach the transport", async () => {
    await expect(placeOrder(args(T_OPEN_LONG, FOUNDER))).rejects.toThrow(
      "no network in tests",
    );
    expect(opened).toHaveLength(1);
  });

  it("lets a close through for a wallet NOT on the list (nobody is trapped)", async () => {
    process.env.COTA_REAL_MONEY_ALLOWLIST = "";
    await expect(placeOrder(args(T_CLOSE_LONG, OTHER))).rejects.toThrow(
      "no network in tests",
    );
    expect(opened).toHaveLength(1);
  });
});
