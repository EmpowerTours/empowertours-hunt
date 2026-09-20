import { describe, expect, it } from "vitest";
import {
  affordableWithGas,
  checkPayment,
  type OnChainTransfer,
  type PaymentExpectation,
} from "./payment";

/* ---------------------------------------------------------------------------
   This is the check that lets a licence leave the relayer, so every way it
   could wrongly say yes is worth a test of its own.
--------------------------------------------------------------------------- */

const PAYER = "0xAbC0000000000000000000000000000000000001";
const RELAYER = "0xRELAY000000000000000000000000000000000f".replace("R", "b");
const PRICE = 300_000_000_000_000_000_000n; // 300 WMON, the Dime Que Sí collector price

const EXPECT: PaymentExpectation = {
  payer: PAYER.toLowerCase(),
  relayer: RELAYER,
  priceWei: PRICE,
  minConfirmations: 1,
};

function transfer(over: Partial<OnChainTransfer> = {}): OnChainTransfer {
  return {
    from: PAYER,
    to: RELAYER,
    valueWei: PRICE,
    status: "success",
    confirmations: 1,
    ...over,
  };
}

describe("checkPayment", () => {
  it("accepts the exact price", () => {
    expect(checkPayment(transfer(), EXPECT)).toEqual({
      ok: true,
      overpaidWei: 0n,
    });
  });

  it("accepts an overpayment and reports the surplus", () => {
    const r = checkPayment(transfer({ valueWei: PRICE + 5n }), EXPECT);
    expect(r).toEqual({ ok: true, overpaidWei: 5n });
  });

  it("refuses a payment one wei short", () => {
    expect(checkPayment(transfer({ valueWei: PRICE - 1n }), EXPECT)).toEqual({
      ok: false,
      reason: "payment_too_small",
    });
  });

  it("refuses a reverted transfer, which moved nothing", () => {
    expect(checkPayment(transfer({ status: "reverted" }), EXPECT)).toEqual({
      ok: false,
      reason: "payment_reverted",
    });
  });

  it("refuses an unconfirmed transfer", () => {
    expect(checkPayment(transfer({ confirmations: 0 }), EXPECT)).toEqual({
      ok: false,
      reason: "payment_unconfirmed",
    });
  });

  it("refuses money sent somewhere other than the relayer", () => {
    expect(
      checkPayment(
        transfer({ to: "0x00000000000000000000000000000000000dead" }),
        EXPECT,
      ),
    ).toEqual({ ok: false, reason: "payment_wrong_recipient" });
  });

  it("refuses a contract creation, which has no recipient", () => {
    expect(checkPayment(transfer({ to: null }), EXPECT)).toEqual({
      ok: false,
      reason: "payment_wrong_recipient",
    });
  });

  // Without this, anyone could point at somebody else's transfer to the
  // relayer and take a licence on the strength of a stranger's money.
  it("refuses somebody else's payment", () => {
    expect(
      checkPayment(
        transfer({ from: "0x0000000000000000000000000000000000000002" }),
        EXPECT,
      ),
    ).toEqual({ ok: false, reason: "payment_wrong_payer" });
  });

  // The chain returns checksummed addresses; Player.walletAddress is stored
  // lowercased. A strict comparison would refuse every genuine payment.
  it("matches addresses regardless of checksum casing", () => {
    const r = checkPayment(
      transfer({ from: PAYER.toUpperCase(), to: RELAYER.toUpperCase() }),
      EXPECT,
    );
    expect(r.ok).toBe(true);
  });

  it("honours a higher confirmation requirement", () => {
    const strict = { ...EXPECT, minConfirmations: 3 };
    expect(checkPayment(transfer({ confirmations: 2 }), strict).ok).toBe(false);
    expect(checkPayment(transfer({ confirmations: 3 }), strict).ok).toBe(true);
  });
});

describe("affordableWithGas", () => {
  const GAS = 1_000_000_000_000_000n; // a spawn's worth of headroom

  it("refuses a balance that exactly equals the price", () => {
    // The transfer itself costs gas, so this hunter cannot actually pay.
    const r = affordableWithGas(PRICE, PRICE, GAS);
    expect(r).toEqual({ ok: false, shortfallWei: GAS });
  });

  it("allows price plus the buffer", () => {
    expect(affordableWithGas(PRICE + GAS, PRICE, GAS)).toEqual({
      ok: true,
      shortfallWei: 0n,
    });
  });

  it("reports a shortfall that includes the buffer", () => {
    expect(affordableWithGas(0n, 10n, 3n)).toEqual({
      ok: false,
      shortfallWei: 13n,
    });
  });

  it("refuses a negative price rather than crediting the hunter", () => {
    expect(() => affordableWithGas(1n, -1n, 0n)).toThrow(RangeError);
  });
});
