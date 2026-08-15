// Regression tests for the payout send path.
//
// Every test in the "double-spend" block below FAILS against the previous
// implementation. That is the point of them: the defects were not theoretical,
// they were reachable through an RPC timeout on a busy block.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    payout: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

const TREASURY = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const HASH = `0x${"ab".repeat(32)}` as const;

vi.mock("viem/accounts", () => ({
  privateKeyToAccount: vi.fn(() => ({ address: TREASURY })),
}));

const chainMock = {
  getBalance: vi.fn(),
  getTransactionCount: vi.fn(),
  estimateFeesPerGas: vi.fn(),
  getGasPrice: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  getTransactionReceipt: vi.fn(),
  getTransaction: vi.fn(),
};
const walletMock = {
  account: { address: TREASURY },
  sendTransaction: vi.fn(),
};

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => chainMock),
    createWalletClient: vi.fn(() => walletMock),
  };
});

import { TransactionReceiptNotFoundError } from "viem";
import { prisma } from "@/lib/db/prisma";
import {
  sendApprovedPayout,
  reconcileOutstandingPayouts,
  rpcUrl,
} from "@/lib/hunt/payout";

const findUnique = vi.mocked(prisma.payout.findUnique);
const findFirst = vi.mocked(prisma.payout.findFirst);
const findMany = vi.mocked(prisma.payout.findMany);
const updateMany = vi.mocked(prisma.payout.updateMany);

const ONE_MON = 10n ** 18n;
const SPAWN_AMOUNT = ONE_MON / 1000n;

/** Every `data` payload written to Payout during a test. */
function writes(): Array<Record<string, unknown>> {
  return updateMany.mock.calls.map(
    (c) => (c[0] as { data: Record<string, unknown> }).data,
  );
}
function wheres(): Array<Record<string, unknown>> {
  return updateMany.mock.calls.map(
    (c) => (c[0] as { where: Record<string, unknown> }).where,
  );
}
function statusesWritten(): unknown[] {
  return writes()
    .map((d) => d.status)
    .filter((s) => s !== undefined);
}

function approvedRow(over: Record<string, unknown> = {}) {
  return {
    id: "payout_1",
    status: "APPROVED",
    amountMonWei: SPAWN_AMOUNT.toString(),
    nonce: null,
    txHash: null,
    player: { walletAddress: RECIPIENT },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.HUNT_TREASURY_PRIVATE_KEY = `0x${"11".repeat(32)}`;
  delete process.env.MONAD_RPC_URL;

  findUnique.mockResolvedValue(approvedRow() as never);
  findFirst.mockResolvedValue(null as never);
  findMany.mockResolvedValue([] as never);
  updateMany.mockResolvedValue({ count: 1 } as never);

  chainMock.getBalance.mockResolvedValue(ONE_MON);
  chainMock.getTransactionCount.mockResolvedValue(7);
  chainMock.estimateFeesPerGas.mockResolvedValue({
    maxFeePerGas: 50_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  chainMock.waitForTransactionReceipt.mockResolvedValue({
    status: "success",
    blockNumber: 100n,
  });
  walletMock.sendTransaction.mockResolvedValue(HASH);
});

afterEach(() => {
  delete process.env.MONAD_RPC_URL;
});

describe("sendApprovedPayout — the happy path", () => {
  it("pins the nonce and SENDING before broadcasting, then records SENT", async () => {
    const res = await sendApprovedPayout("payout_1");
    expect(res).toEqual({ ok: true, txHash: HASH, status: "SENT" });

    // Order matters more than content here: a row that is broadcast before its
    // nonce is persisted is a row the reconciler cannot identify on chain.
    const claim = writes()[0];
    expect(claim.status).toBe("SENDING");
    expect(claim.nonce).toBe(7);
    expect(updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      walletMock.sendTransaction.mock.invocationCallOrder[0],
    );

    expect(walletMock.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        to: RECIPIENT,
        value: SPAWN_AMOUNT,
        nonce: 7,
        gas: 21_000n,
      }),
    );
    expect(statusesWritten()).toEqual(["SENDING", "SENT"]);
  });

  it("waits for the receipt with an explicit timeout rather than the 180s default", async () => {
    await sendApprovedPayout("payout_1");
    const args = chainMock.waitForTransactionReceipt.mock.calls[0][0] as {
      timeout?: number;
    };
    expect(typeof args.timeout).toBe("number");
    expect(args.timeout).toBeGreaterThan(0);
  });
});

describe("C2 — an already-broadcast payout is never re-armed", () => {
  it("escalates a receipt-wait timeout to NEEDS_RECONCILIATION, never back to APPROVED", async () => {
    // THE defect. viem's waitForTransactionReceipt throws on its 180s timeout
    // and on any RPC blip; the old catch block set the row back to APPROVED,
    // which is exactly the state the sender picks up. The next sweep paid the
    // same player again.
    chainMock.waitForTransactionReceipt.mockRejectedValue(
      new Error("timed out while waiting for transaction to be confirmed"),
    );

    const res = await sendApprovedPayout("payout_1");

    expect(res.ok).toBe(false);
    expect(res.needsReconciliation).toBe(true);
    expect(res.status).toBe("NEEDS_RECONCILIATION");
    expect(statusesWritten()).not.toContain("APPROVED");
    expect(statusesWritten()).not.toContain("FAILED");
    expect(statusesWritten()).toContain("NEEDS_RECONCILIATION");
  });

  it("escalates a throwing broadcast, because the node may already have it", async () => {
    walletMock.sendTransaction.mockRejectedValue(new Error("socket hang up"));

    const res = await sendApprovedPayout("payout_1");

    expect(res.needsReconciliation).toBe(true);
    expect(statusesWritten()).not.toContain("APPROVED");
    expect(statusesWritten()).not.toContain("FAILED");
  });

  it("keeps a reverted transaction out of FAILED, because a txHash exists", async () => {
    chainMock.waitForTransactionReceipt.mockResolvedValue({
      status: "reverted",
      blockNumber: 100n,
    });

    const res = await sendApprovedPayout("payout_1");

    expect(res.status).toBe("NEEDS_RECONCILIATION");
    // The schema permits FAILED only while txHash IS NULL, and FAILED is the
    // one status a human may return to APPROVED.
    expect(statusesWritten()).not.toContain("FAILED");
  });

  it("does not re-arm when the hash cannot be persisted after broadcast", async () => {
    updateMany
      .mockResolvedValueOnce({ count: 1 } as never) // the SENDING claim
      .mockRejectedValueOnce(new Error("db gone")) // persisting the hash
      .mockResolvedValue({ count: 1 } as never);

    const res = await sendApprovedPayout("payout_1");

    expect(res.needsReconciliation).toBe(true);
    expect(statusesWritten()).not.toContain("APPROVED");
  });
});

describe("C3 — FAILED is not an in-flight lock", () => {
  it("claims the row with SENDING, and only from APPROVED", async () => {
    await sendApprovedPayout("payout_1");

    const claimWhere = wheres()[0];
    expect(claimWhere).toMatchObject({ id: "payout_1", status: "APPROVED" });
    expect(writes()[0].status).toBe("SENDING");
    // The old code wrote FAILED here, which the schema documents as
    // retry-safe — so an operator or sweeper could legitimately re-approve a
    // row that was mid-broadcast.
    expect(writes()[0].failReason).not.toMatch(/send in flight/);
  });

  it("does not broadcast when the claim loses the race", async () => {
    updateMany.mockResolvedValue({ count: 0 } as never);

    const res = await sendApprovedPayout("payout_1");

    expect(res.ok).toBe(false);
    expect(walletMock.sendTransaction).not.toHaveBeenCalled();
  });

  it("refuses a row that is not APPROVED", async () => {
    for (const status of [
      "PENDING",
      "SENDING",
      "SENT",
      "NEEDS_RECONCILIATION",
      "VOIDED",
    ]) {
      vi.clearAllMocks();
      findUnique.mockResolvedValue(approvedRow({ status }) as never);
      const res = await sendApprovedPayout("payout_1");
      expect(res.ok).toBe(false);
      expect(walletMock.sendTransaction).not.toHaveBeenCalled();
    }
  });

  it("refuses to send anything at all while another row is unresolved", async () => {
    findFirst.mockResolvedValue({
      id: "payout_stuck",
      status: "NEEDS_RECONCILIATION",
      nonce: 6,
      txHash: null,
    } as never);

    const res = await sendApprovedPayout("payout_1");

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/payout_stuck/);
    expect(walletMock.sendTransaction).not.toHaveBeenCalled();
    // And the row it refused to send is untouched, still APPROVED.
    expect(statusesWritten()).toEqual([]);
  });
});

describe("H4 — parsing happens before the row is claimed", () => {
  it("never enters SENDING for an unparseable amount", async () => {
    // The old code called BigInt(amountMonWei) AFTER the status claim and
    // outside the try, so a malformed value wedged the row in the in-flight
    // status forever with no path out.
    findUnique.mockResolvedValue(
      approvedRow({ amountMonWei: "1e18" }) as never,
    );

    const res = await sendApprovedPayout("payout_1");

    expect(res.ok).toBe(false);
    expect(statusesWritten()).not.toContain("SENDING");
    expect(statusesWritten()).toEqual(["FAILED"]);
    // FAILED is only legal with no txHash, and that is what makes it
    // re-approvable by a human.
    expect(wheres()[0]).toMatchObject({ status: "APPROVED", txHash: null });
    expect(walletMock.sendTransaction).not.toHaveBeenCalled();
  });

  it("voids a non-positive amount instead of broadcasting a zero transfer", async () => {
    findUnique.mockResolvedValue(approvedRow({ amountMonWei: "0" }) as never);

    const res = await sendApprovedPayout("payout_1");

    expect(res.status).toBe("VOIDED");
    expect(walletMock.sendTransaction).not.toHaveBeenCalled();
  });

  it("fails a malformed recipient before claiming the row", async () => {
    findUnique.mockResolvedValue(
      approvedRow({ player: { walletAddress: "not-an-address" } }) as never,
    );

    const res = await sendApprovedPayout("payout_1");

    expect(res.status).toBe("FAILED");
    expect(statusesWritten()).not.toContain("SENDING");
    expect(walletMock.sendTransaction).not.toHaveBeenCalled();
  });
});

describe("M4 — gas, nonce and RPC configuration", () => {
  it("reserves gas in the balance check", async () => {
    // A treasury holding exactly the payout amount cannot pay the gas. The old
    // check compared the balance against the value alone and broadcast anyway.
    chainMock.getBalance.mockResolvedValue(SPAWN_AMOUNT);

    const res = await sendApprovedPayout("payout_1");

    expect(res.ok).toBe(false);
    expect(res.status).toBe("APPROVED");
    expect(walletMock.sendTransaction).not.toHaveBeenCalled();
    // Status untouched: nothing was broadcast, so this row is still a clean
    // APPROVED for the next sweep once the treasury is topped up.
    expect(statusesWritten()).toEqual([]);
  });

  it("sends when the balance covers value plus gas", async () => {
    chainMock.getBalance.mockResolvedValue(
      SPAWN_AMOUNT + 21_000n * 50_000_000_000n,
    );
    const res = await sendApprovedPayout("payout_1");
    expect(res.ok).toBe(true);
  });

  it("refuses to broadcast when fees cannot be estimated at all", async () => {
    chainMock.estimateFeesPerGas.mockRejectedValue(new Error("rpc down"));
    chainMock.getGasPrice.mockRejectedValue(new Error("rpc down"));

    const res = await sendApprovedPayout("payout_1");

    expect(res.ok).toBe(false);
    expect(walletMock.sendTransaction).not.toHaveBeenCalled();
    expect(statusesWritten()).toEqual([]);
  });

  it("falls back to gasPrice on a chain without EIP-1559 estimation", async () => {
    chainMock.estimateFeesPerGas.mockRejectedValue(new Error("no eip1559"));
    chainMock.getGasPrice.mockResolvedValue(60_000_000_000n);

    const res = await sendApprovedPayout("payout_1");

    expect(res.ok).toBe(true);
    expect(walletMock.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ maxFeePerGas: 60_000_000_000n }),
    );
  });

  it("pins the PENDING nonce, so a queued transaction is not replaced", async () => {
    await sendApprovedPayout("payout_1");
    expect(chainMock.getTransactionCount).toHaveBeenCalledWith({
      address: TREASURY,
      blockTag: "pending",
    });
  });

  it("refuses a nonce another payout already pinned", async () => {
    findFirst
      .mockResolvedValueOnce(null as never) // no unresolved row
      .mockResolvedValueOnce({ id: "payout_0", status: "SENT" } as never); // nonce taken

    const res = await sendApprovedPayout("payout_1");

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nonce 7 is already pinned/);
    expect(walletMock.sendTransaction).not.toHaveBeenCalled();
  });

  it("reads MONAD_RPC_URL and only falls back to the public endpoint", () => {
    expect(rpcUrl()).toBe("https://rpc.monad.xyz");
    process.env.MONAD_RPC_URL = "https://private.example/rpc";
    expect(rpcUrl()).toBe("https://private.example/rpc");
  });

  it("serialises concurrent sends through one queue", async () => {
    // Two callers reading the same pending nonce would produce two
    // transactions where the second replaces the first.
    let inFlight = 0;
    let maxInFlight = 0;
    walletMock.sendTransaction.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return HASH;
    });

    await Promise.all([
      sendApprovedPayout("payout_1"),
      sendApprovedPayout("payout_2"),
    ]);

    expect(maxInFlight).toBe(1);
  });

  it("does not wedge the queue when one send throws", async () => {
    walletMock.sendTransaction.mockRejectedValueOnce(new Error("boom"));
    const first = await sendApprovedPayout("payout_1");
    expect(first.ok).toBe(false);

    walletMock.sendTransaction.mockResolvedValue(HASH);
    findFirst.mockResolvedValue(null as never);
    const second = await sendApprovedPayout("payout_2");
    expect(second.ok).toBe(true);
  });
});

describe("reconcileOutstandingPayouts — resolve by asking the chain", () => {
  const now = new Date("2026-08-12T12:00:00.000Z");

  it("only looks at rows old enough that no sender is still inside them", async () => {
    await reconcileOutstandingPayouts({ now, minAgeMs: 120_000 });
    const args = findMany.mock.calls[0]?.[0];
    if (!args) throw new Error("payout.findMany was never called");
    const where = args.where as {
      status: { in: string[] };
      updatedAt: { lt: Date };
    };
    expect(where.status.in).toEqual(["SENDING", "NEEDS_RECONCILIATION"]);
    expect(where.updatedAt.lt).toEqual(new Date(now.getTime() - 120_000));
  });

  it("marks SENT when the chain confirms the recorded hash", async () => {
    findMany.mockResolvedValue([
      { id: "p1", status: "SENDING", nonce: 7, txHash: HASH },
    ] as never);
    chainMock.getTransactionReceipt.mockResolvedValue({
      status: "success",
      blockNumber: 42n,
    });

    const res = await reconcileOutstandingPayouts({ now });

    expect(res.outcomes[0].to).toBe("SENT");
    expect(writes()[0]).toMatchObject({ status: "SENT" });
    expect(walletMock.sendTransaction).not.toHaveBeenCalled();
  });

  it("leaves a broadcast-but-unmined row alone rather than deciding it never happened", async () => {
    findMany.mockResolvedValue([
      { id: "p1", status: "SENDING", nonce: 7, txHash: HASH },
    ] as never);
    chainMock.getTransactionReceipt.mockRejectedValue(
      new TransactionReceiptNotFoundError({ hash: HASH }),
    );
    // Nonce 7 not yet consumed: mined and pending counts are both 7.
    chainMock.getTransactionCount.mockResolvedValue(7);

    const res = await reconcileOutstandingPayouts({ now });

    expect(res.outcomes[0].to).toBe("UNCHANGED");
    expect(statusesWritten()).toEqual([]);
  });

  it("flags a row whose nonce was taken by some other transaction", async () => {
    findMany.mockResolvedValue([
      { id: "p1", status: "SENDING", nonce: 7, txHash: HASH },
    ] as never);
    chainMock.getTransactionReceipt.mockRejectedValue(
      new TransactionReceiptNotFoundError({ hash: HASH }),
    );
    chainMock.getTransactionCount.mockResolvedValue(9);

    const res = await reconcileOutstandingPayouts({ now });

    expect(res.outcomes[0].to).toBe("NEEDS_RECONCILIATION");
    expect(statusesWritten()).not.toContain("FAILED");
  });

  it("only FAILs a hashless row when BOTH the mined and pending nonce prove it never landed", async () => {
    findMany.mockResolvedValue([
      { id: "p1", status: "SENDING", nonce: 7, txHash: null },
    ] as never);
    chainMock.getTransactionCount.mockResolvedValue(7);

    const res = await reconcileOutstandingPayouts({ now });

    expect(res.outcomes[0].to).toBe("FAILED");
    // The guard that keeps FAILED honest — and therefore keeps
    // FAILED -> APPROVED safe for a human to use.
    expect(wheres()[0]).toMatchObject({ txHash: null });
  });

  it("does NOT FAIL a hashless row while a transaction is still pending at that nonce", async () => {
    findMany.mockResolvedValue([
      { id: "p1", status: "SENDING", nonce: 7, txHash: null },
    ] as never);
    // Mined count says nothing landed, but the mempool holds one: marking this
    // FAILED would re-open it for a human to re-approve, and the original
    // could then mine as well.
    chainMock.getTransactionCount.mockImplementation(
      async ({ blockTag }: { blockTag: string }) =>
        blockTag === "pending" ? 8 : 7,
    );
    chainMock.getTransaction.mockRejectedValue(new Error("unsupported"));

    const res = await reconcileOutstandingPayouts({ now });

    expect(res.outcomes[0].to).toBe("NEEDS_RECONCILIATION");
    expect(statusesWritten()).not.toContain("FAILED");
  });

  it("recovers a lost hash from (treasury, nonce) when the node supports it", async () => {
    findMany.mockResolvedValue([
      { id: "p1", status: "SENDING", nonce: 7, txHash: null },
    ] as never);
    chainMock.getTransactionCount.mockResolvedValue(9);
    chainMock.getTransaction.mockResolvedValue({ hash: HASH });

    const res = await reconcileOutstandingPayouts({ now });

    expect(chainMock.getTransaction).toHaveBeenCalledWith({
      sender: TREASURY,
      nonce: 7,
    });
    expect(res.outcomes[0].detail).toMatch(/recovered hash/);
    expect(writes().some((d) => d.txHash === HASH)).toBe(true);
  });

  it("never sends anything", async () => {
    findMany.mockResolvedValue([
      { id: "p1", status: "NEEDS_RECONCILIATION", nonce: 7, txHash: HASH },
    ] as never);
    chainMock.getTransactionReceipt.mockResolvedValue({
      status: "success",
      blockNumber: 42n,
    });

    await reconcileOutstandingPayouts({ now });

    expect(walletMock.sendTransaction).not.toHaveBeenCalled();
  });
});
