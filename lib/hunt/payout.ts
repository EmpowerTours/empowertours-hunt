// MON payout — the irreversible step.
//
// Sending native MON cannot be undone, so per the house rule ("human gate
// before anything irreversible") nothing here decides that money is owed. A
// spawn collect creates a Payout; policy (lib/hunt/approval.ts) or a person
// moves it to APPROVED; only then may `sendApprovedPayout` broadcast it.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE:
//
//   Once `sendTransaction` has been called for a row, that row must never
//   again reach a status the sender will pick up. Not on a timeout, not on an
//   RPC blip, not on a crash. An ambiguous outcome is resolved by ASKING THE
//   CHAIN (see `reconcileOutstandingPayouts`), never by sending again.
//
// The previous version broke that rule twice, and each break paid a player
// twice with real money:
//
//   C2  `waitForTransactionReceipt` has a 180s default timeout (verified in
//       viem 2.55.13: WaitForTransactionReceiptParameters.timeout @default
//       180_000) and throws on expiry or any RPC hiccup. The catch block
//       covered the broadcast AND the wait, and set the row back to APPROVED —
//       exactly the state the send guard accepts. Its comment said "the money
//       did not move, so this is safe to retry", which is false for every
//       throw at or after the broadcast. A slow block, a flaky RPC, a
//       redeploy: any of those re-armed a transaction that was already in the
//       mempool.
//
//   C3  FAILED was used as the in-flight lock while the schema documents
//       FAILED as the retry-safe state, and the header described a SENDING
//       status that did not exist. The enum now has SENDING and
//       NEEDS_RECONCILIATION, and this file uses them literally:
//
//         PENDING              -> APPROVED | VOIDED
//         APPROVED             -> SENDING | VOIDED
//         SENDING              -> SENT | NEEDS_RECONCILIATION
//                                 | FAILED (reconciler only, txHash IS NULL
//                                   and the nonce provably unconsumed)
//         FAILED               -> APPROVED (human only, txHash IS NULL only)
//         NEEDS_RECONCILIATION -> SENT | FAILED (reconciler/human; never by
//                                 re-sending)
//         SENT, VOIDED           terminal
//
// Failure modes and the decided recovery path for each — no blind retry
// anywhere, no loop without an exit:
//
//   malformed amount / address    fail loudly BEFORE the status claim, row
//                                 goes FAILED with txHash NULL, human fixes
//                                 the data and re-approves.
//   treasury underfunded          fail loudly, row stays APPROVED untouched
//                                 (nothing was broadcast), operator tops up.
//   fee estimation unavailable    fail loudly, do not broadcast blind.
//   nonce already used by a row   fail loudly; broadcasting would REPLACE a
//                                 previous transaction.
//   an unresolved row exists      refuse to send anything at all until the
//                                 reconciler or a human clears it. At most one
//                                 ambiguous row can ever exist.
//   sendTransaction throws        AMBIGUOUS -> NEEDS_RECONCILIATION. The node
//                                 may have accepted it before the socket died.
//   receipt wait throws/times out AMBIGUOUS -> NEEDS_RECONCILIATION.
//   receipt says reverted         -> NEEDS_RECONCILIATION. The schema forbids
//                                 FAILED while a txHash exists, and a human
//                                 should look at a reverted native transfer.
//   DB write fails after send     best-effort mark, then rely on the pinned
//                                 (treasury, nonce) to reconcile.

import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  TransactionReceiptNotFoundError,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PayoutStatus } from "@prisma/client";
import { monad } from "@/lib/monad";
import { prisma } from "@/lib/db/prisma";
import { toWei } from "@/lib/wei";

/** A native MON transfer to an EOA costs exactly this. */
const GAS_LIMIT_NATIVE_TRANSFER = 21_000n;

/** Bounded on purpose: an unbounded wait is a process that never fails. */
const DEFAULT_RECEIPT_TIMEOUT_MS = 120_000;

/** Do not touch a row the sender may still be inside. */
const DEFAULT_RECONCILE_MIN_AGE_MS = 120_000;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Statuses that mean "a transaction may exist on chain for this row". */
const UNRESOLVED_STATUSES = ["SENDING", "NEEDS_RECONCILIATION"] as const;

/**
 * RPC endpoint. `http()` with no argument silently used the chain's public
 * endpoint, so an operator setting MONAD_RPC_URL got no effect and every
 * payout went through a shared rate-limited node.
 */
export function rpcUrl(): string {
  return process.env.MONAD_RPC_URL || monad.rpcUrls.default.http[0];
}

function receiptTimeoutMs(): number {
  const raw = process.env.PAYOUT_RECEIPT_TIMEOUT_MS;
  if (!raw) return DEFAULT_RECEIPT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_RECEIPT_TIMEOUT_MS;
}

// Clients are built per call rather than at module load. At module load the
// env may not be populated yet in a serverless cold start, and a memoised
// client would pin the first RPC URL it ever saw for the life of the process.
function publicClient() {
  return createPublicClient({ chain: monad, transport: http(rpcUrl()) });
}

function treasuryWallet() {
  const pk = process.env.HUNT_TREASURY_PRIVATE_KEY;
  if (!pk) {
    // Deliberately not falling back to DEPLOYER_PRIVATE_KEY. The hunt treasury
    // is a bounded, separately-funded hot wallet; reusing the deployer key
    // would put the whole ecosystem's deploy authority behind a GPS check.
    throw new Error("HUNT_TREASURY_PRIVATE_KEY not set");
  }
  const account = privateKeyToAccount(pk as Hex);
  return createWalletClient({
    account,
    chain: monad,
    transport: http(rpcUrl()),
  });
}

export interface SendResult {
  ok: boolean;
  txHash?: string;
  error?: string;
  /** The status the row was left in, so a caller can stop rather than loop. */
  status?: PayoutStatus;
  /** True when the on-chain outcome is unknown. A human or the reconciler
   *  resolves it; nothing may re-send it. */
  needsReconciliation?: boolean;
}

// --- treasury serialisation -------------------------------------------------
//
// Every send from the treasury goes through one queue, so two concurrent
// callers cannot read the same pending nonce and produce two transactions that
// replace each other. This is a PER-PROCESS guarantee. Across processes the
// guards are the DB ones: the APPROVED -> SENDING compare-and-set, the
// per-nonce collision check, and the refusal to send while any unresolved row
// exists.

let treasuryQueue: Promise<unknown> = Promise.resolve();

export function enqueueTreasuryOp<T>(op: () => Promise<T>): Promise<T> {
  // `.then(op, op)` so one failed send does not wedge the queue forever.
  const run = treasuryQueue.then(op, op);
  treasuryQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// --- status helpers ---------------------------------------------------------

/**
 * Move a row to NEEDS_RECONCILIATION. Only ever called after the point where a
 * transaction may exist on chain. Best-effort: if the database is what broke,
 * the pinned (treasury, nonce) on the SENDING row is still enough for the
 * reconciler to work from.
 */
async function markNeedsReconciliation(
  payoutId: string,
  reason: string,
  txHash?: string,
): Promise<void> {
  try {
    await prisma.payout.updateMany({
      where: { id: payoutId, status: { in: ["SENDING"] } },
      data: {
        status: "NEEDS_RECONCILIATION",
        failReason: reason.slice(0, 500),
        ...(txHash ? { txHash } : {}),
      },
    });
  } catch (e) {
    // Loud, not silent: this row now needs a person.
    console.error(
      "[payout] could not mark NEEDS_RECONCILIATION",
      payoutId,
      e instanceof Error ? e.message : e,
    );
  }
}

/**
 * FAILED means "nothing was broadcast". The `txHash: null` guard is what makes
 * that true rather than merely intended — a row that ever recorded a hash can
 * never take this path, and FAILED is the only status a human may return to
 * APPROVED.
 */
async function markFailedBeforeBroadcast(
  payoutId: string,
  fromStatus: PayoutStatus,
  reason: string,
): Promise<boolean> {
  const res = await prisma.payout.updateMany({
    where: { id: payoutId, status: fromStatus, txHash: null },
    data: { status: "FAILED", failReason: reason.slice(0, 500) },
  });
  return res.count === 1;
}

// FAILED -> APPROVED is deliberately NOT implemented here. It is a human
// transition and it already exists once, in the admin lane
// (lib/admin/payouts.ts `approvePayout`, guarded on `txHash: null` and paired
// with an AdminAction audit row). A second, unaudited re-approval path in the
// send module would be a way to re-arm a payout without anyone's name on it.

/**
 * The unresolved row, if there is one. While this returns non-null the sender
 * refuses to broadcast anything: a row whose nonce may or may not be spent
 * makes every subsequent nonce a guess.
 */
export async function findUnresolvedPayout(): Promise<{
  id: string;
  status: PayoutStatus;
  nonce: number | null;
  txHash: string | null;
} | null> {
  return prisma.payout.findFirst({
    where: { status: { in: [...UNRESOLVED_STATUSES] } },
    select: { id: true, status: true, nonce: true, txHash: true },
    orderBy: { createdAt: "asc" },
  });
}

// --- the send ---------------------------------------------------------------

/**
 * Broadcast a single APPROVED payout.
 *
 * Not reachable from any route a player can call — this is admin-triggered or
 * run by the keeper at /api/cron/payouts after approval.
 */
export async function sendApprovedPayout(
  payoutId: string,
): Promise<SendResult> {
  return enqueueTreasuryOp(() => sendApprovedPayoutSerial(payoutId));
}

async function sendApprovedPayoutSerial(payoutId: string): Promise<SendResult> {
  const payout = await prisma.payout.findUnique({
    where: { id: payoutId },
    include: { player: true },
  });
  if (!payout) return { ok: false, error: "payout not found" };
  if (payout.status !== "APPROVED") {
    return {
      ok: false,
      status: payout.status,
      error: `payout is ${payout.status}, not APPROVED`,
    };
  }

  // --- parse EVERYTHING before claiming the row ---------------------------
  // H4: the old code ran BigInt(amountMonWei) after the status claim and
  // outside the try, so a malformed value wedged the row in the in-flight
  // status with no path out. Decimal(78,0) makes that value impossible to
  // store now, but the parse still happens while the row is still APPROVED,
  // so the worst case is a FAILED row a human can fix rather than a stuck one.
  let amount: bigint;
  try {
    amount = toWei(payout.amountMonWei);
  } catch (e) {
    const reason = `unparseable amount: ${e instanceof Error ? e.message : String(e)}`;
    const marked = await markFailedBeforeBroadcast(
      payoutId,
      "APPROVED",
      reason,
    );
    return {
      ok: false,
      ...(marked ? { status: "FAILED" as const } : {}),
      error: reason,
    };
  }

  if (amount <= 0n) {
    await prisma.payout.updateMany({
      where: { id: payoutId, status: "APPROVED" },
      data: { status: "VOIDED", voidReason: "non-positive amount" },
    });
    return { ok: false, status: "VOIDED", error: "non-positive amount" };
  }

  const to = payout.player.walletAddress;
  if (!ADDRESS_RE.test(to)) {
    const reason = "recipient is not a 20-byte hex address";
    const marked = await markFailedBeforeBroadcast(
      payoutId,
      "APPROVED",
      reason,
    );
    return {
      ok: false,
      ...(marked ? { status: "FAILED" as const } : {}),
      error: reason,
    };
  }

  // --- refuse to act while anything is unresolved -------------------------
  const unresolved = await findUnresolvedPayout();
  if (unresolved && unresolved.id !== payoutId) {
    return {
      ok: false,
      error:
        `payout ${unresolved.id} is ${unresolved.status} (nonce ${unresolved.nonce ?? "?"}); ` +
        "resolve it against the chain before sending anything else",
    };
  }

  // --- pre-broadcast checks, all while the row is still APPROVED ----------
  let treasury: Hex;
  let wallet: ReturnType<typeof treasuryWallet>;
  try {
    wallet = treasuryWallet();
    treasury = wallet.account.address;
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "treasury unavailable",
    };
  }

  const pub = publicClient();

  let maxFeePerGas: bigint;
  let maxPriorityFeePerGas: bigint | undefined;
  try {
    const fees = await pub.estimateFeesPerGas();
    maxFeePerGas = fees.maxFeePerGas;
    maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
  } catch {
    try {
      maxFeePerGas = await pub.getGasPrice();
    } catch (e) {
      // Fail loudly rather than broadcasting with a guessed fee: an underpriced
      // transaction sits in the mempool and becomes exactly the ambiguous row
      // this file is built to avoid.
      return {
        ok: false,
        error: `cannot estimate gas fees: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  // M4: the old balance check compared the balance against the transfer value
  // alone, so a treasury holding exactly the payout amount passed the check and
  // then failed to cover gas.
  const gasReserve = GAS_LIMIT_NATIVE_TRANSFER * maxFeePerGas;
  let balance: bigint;
  try {
    balance = await pub.getBalance({ address: treasury });
  } catch (e) {
    return {
      ok: false,
      error: `cannot read treasury balance: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (balance < amount + gasReserve) {
    const reason =
      `treasury holds ${formatEther(balance)} MON, needs ${formatEther(amount)} ` +
      `+ ${formatEther(gasReserve)} gas`;
    // Status untouched: nothing was broadcast, so the row is still a clean
    // APPROVED that the keeper will pick up once the treasury is topped up.
    await prisma.payout.updateMany({
      where: { id: payoutId, status: "APPROVED" },
      data: { failReason: reason },
    });
    return { ok: false, status: "APPROVED", error: reason };
  }

  // --- nonce: pinned, checked for collisions, persisted BEFORE broadcast ---
  let nonce: number;
  try {
    nonce = await pub.getTransactionCount({
      address: treasury,
      blockTag: "pending",
    });
  } catch (e) {
    return {
      ok: false,
      error: `cannot read treasury nonce: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const nonceTaken = await prisma.payout.findFirst({
    where: {
      nonce,
      status: { in: ["SENDING", "SENT", "NEEDS_RECONCILIATION"] },
      NOT: { id: payoutId },
    },
    select: { id: true, status: true },
  });
  if (nonceTaken) {
    // Broadcasting at a nonce another row already used would REPLACE that
    // transaction. Never guess here.
    //
    // Rotating HUNT_TREASURY_PRIVATE_KEY makes every fresh nonce collide with
    // the old wallet's SENT rows and halts the sweep. That is the intended
    // behaviour: a treasury swap needs a person to look at the open queue, not
    // a sender that quietly starts spending from a different account.
    return {
      ok: false,
      error: `nonce ${nonce} is already pinned by payout ${nonceTaken.id} (${nonceTaken.status})`,
    };
  }

  // The compare-and-set. Whoever wins owns the send; everyone else is told the
  // row is no longer theirs. The nonce lands in the same write, so a row can
  // never be SENDING without the nonce the reconciler needs.
  const claimed = await prisma.payout.updateMany({
    where: { id: payoutId, status: "APPROVED" },
    data: {
      status: "SENDING",
      nonce,
      failReason: "nonce pinned, broadcast pending",
    },
  });
  if (claimed.count === 0) {
    return {
      ok: false,
      error: "payout is not APPROVED (already claimed, sent, or voided)",
    };
  }

  // --- past this line the money may move. No path returns to APPROVED. ----

  let hash: Hex;
  try {
    hash = await wallet.sendTransaction({
      to: to as Hex,
      value: amount,
      nonce,
      gas: GAS_LIMIT_NATIVE_TRANSFER,
      maxFeePerGas,
      ...(maxPriorityFeePerGas === undefined ? {} : { maxPriorityFeePerGas }),
    });
  } catch (e) {
    // AMBIGUOUS. The node may have accepted the transaction and then the
    // connection dropped; viem cannot tell us which. The reconciler decides by
    // looking at whether nonce `nonce` was consumed on chain.
    const reason = `broadcast threw: ${e instanceof Error ? e.message : String(e)}`;
    await markNeedsReconciliation(payoutId, reason);
    return {
      ok: false,
      status: "NEEDS_RECONCILIATION",
      needsReconciliation: true,
      error: reason,
    };
  }

  try {
    await prisma.payout.updateMany({
      where: { id: payoutId, status: "SENDING" },
      data: { txHash: hash, failReason: "broadcast, awaiting receipt" },
    });
  } catch (e) {
    await markNeedsReconciliation(
      payoutId,
      `broadcast ${hash} but could not persist the hash: ${e instanceof Error ? e.message : String(e)}`,
      hash,
    );
    return {
      ok: false,
      txHash: hash,
      status: "NEEDS_RECONCILIATION",
      needsReconciliation: true,
      error: "broadcast, hash not persisted",
    };
  }

  let receiptStatus: "success" | "reverted";
  try {
    const receipt = await pub.waitForTransactionReceipt({
      hash,
      timeout: receiptTimeoutMs(),
    });
    receiptStatus = receipt.status;
  } catch (e) {
    // C2, the defect that paid twice. A timeout here means "we stopped
    // watching", NOT "it did not happen". Escalate; never re-arm.
    const reason = `receipt wait failed for ${hash}: ${e instanceof Error ? e.message : String(e)}`;
    await markNeedsReconciliation(payoutId, reason, hash);
    return {
      ok: false,
      txHash: hash,
      status: "NEEDS_RECONCILIATION",
      needsReconciliation: true,
      error: reason,
    };
  }

  if (receiptStatus !== "success") {
    // A native transfer that reverts means the recipient rejected it. Not
    // FAILED: the schema reserves FAILED for rows with no txHash, and this one
    // consumed a nonce and burnt gas. A person decides what happens next.
    const reason = `transaction ${hash} reverted`;
    await markNeedsReconciliation(payoutId, reason, hash);
    return {
      ok: false,
      txHash: hash,
      status: "NEEDS_RECONCILIATION",
      needsReconciliation: true,
      error: reason,
    };
  }

  await prisma.payout.updateMany({
    where: { id: payoutId, status: "SENDING" },
    data: {
      status: "SENT",
      sentAt: new Date(),
      failReason: null,
      txHash: hash,
    },
  });
  return { ok: true, txHash: hash, status: "SENT" };
}

// --- reconciliation ---------------------------------------------------------
//
// Resolves SENDING and NEEDS_RECONCILIATION rows by asking the chain. It never
// constructs a wallet client, so it structurally cannot send anything.

export interface ReconcileOptions {
  /** Leave rows younger than this alone — the sender may still be inside one. */
  minAgeMs?: number;
  limit?: number;
  now?: Date;
}

export interface ReconcileOutcome {
  payoutId: string;
  from: PayoutStatus;
  to: PayoutStatus | "UNCHANGED";
  detail: string;
  txHash?: string;
}

export async function reconcileOutstandingPayouts(
  opts: ReconcileOptions = {},
): Promise<{ checked: number; outcomes: ReconcileOutcome[] }> {
  const now = opts.now ?? new Date();
  const minAgeMs = opts.minAgeMs ?? DEFAULT_RECONCILE_MIN_AGE_MS;
  const limit = opts.limit ?? 25;

  const rows = await prisma.payout.findMany({
    where: {
      status: { in: [...UNRESOLVED_STATUSES] },
      updatedAt: { lt: new Date(now.getTime() - minAgeMs) },
    },
    select: { id: true, status: true, nonce: true, txHash: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  if (rows.length === 0) return { checked: 0, outcomes: [] };

  const pub = publicClient();

  // The treasury address is derived from the key, not stored per row: there is
  // exactly one treasury and the nonce is only meaningful against it.
  let treasury: Hex;
  try {
    treasury = treasuryWallet().account.address;
  } catch (e) {
    throw new Error(
      `cannot reconcile without the treasury address: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const minedNonce = await pub.getTransactionCount({
    address: treasury,
    blockTag: "latest",
  });
  const pendingNonce = await pub.getTransactionCount({
    address: treasury,
    blockTag: "pending",
  });

  const outcomes: ReconcileOutcome[] = [];
  for (const row of rows) {
    outcomes.push(
      await reconcileRow(pub, row, { treasury, minedNonce, pendingNonce }),
    );
  }
  return { checked: rows.length, outcomes };
}

async function reconcileRow(
  pub: ReturnType<typeof publicClient>,
  row: {
    id: string;
    status: PayoutStatus;
    nonce: number | null;
    txHash: string | null;
  },
  nonces: { treasury: Hex; minedNonce: number; pendingNonce: number },
): Promise<ReconcileOutcome> {
  const unchanged = (detail: string): ReconcileOutcome => ({
    payoutId: row.id,
    from: row.status,
    to: "UNCHANGED",
    detail,
    ...(row.txHash ? { txHash: row.txHash } : {}),
  });

  // --- we have a hash: the chain can answer directly ---------------------
  if (row.txHash) {
    try {
      const receipt = await pub.getTransactionReceipt({
        hash: row.txHash as Hex,
      });
      if (receipt.status === "success") {
        await prisma.payout.updateMany({
          where: { id: row.id, status: { in: [...UNRESOLVED_STATUSES] } },
          data: {
            status: "SENT",
            sentAt: new Date(),
            failReason: null,
            reconciledAt: new Date(),
            reconciledBy: "cron:reconcile",
          },
        });
        return {
          payoutId: row.id,
          from: row.status,
          to: "SENT",
          detail: `mined in block ${receipt.blockNumber}`,
          txHash: row.txHash,
        };
      }
      await prisma.payout.updateMany({
        where: { id: row.id, status: "SENDING" },
        data: {
          status: "NEEDS_RECONCILIATION",
          failReason: `transaction reverted on chain`,
        },
      });
      // Not FAILED: a hash exists, so this needs a person, not a re-send.
      return {
        payoutId: row.id,
        from: row.status,
        to: "NEEDS_RECONCILIATION",
        detail: "reverted on chain — needs a human decision, never a re-send",
        txHash: row.txHash,
      };
    } catch (e) {
      if (!(e instanceof TransactionReceiptNotFoundError)) {
        return unchanged(
          `RPC error reading receipt: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      // Not mined yet. It may still be in the mempool, so this row stays put:
      // the one thing we must not do is decide it never happened.
      if (row.nonce !== null && nonces.minedNonce > row.nonce) {
        await prisma.payout.updateMany({
          where: { id: row.id, status: "SENDING" },
          data: {
            status: "NEEDS_RECONCILIATION",
            failReason: `nonce ${row.nonce} consumed on chain but ${row.txHash} is not mined — a different transaction took the nonce`,
          },
        });
        return {
          payoutId: row.id,
          from: row.status,
          to: "NEEDS_RECONCILIATION",
          detail: `nonce ${row.nonce} was consumed by some other transaction`,
          txHash: row.txHash,
        };
      }
      return unchanged("broadcast, not yet mined — still in the mempool");
    }
  }

  // --- no hash: decide from the nonce ------------------------------------
  if (row.nonce === null) {
    // SENDING without a nonce should be impossible (they are written in the
    // same update), but a row that never pinned one also never broadcast.
    const ok = await markFailedBeforeBroadcast(
      row.id,
      row.status,
      "no nonce pinned; nothing was ever broadcast",
    );
    return {
      payoutId: row.id,
      from: row.status,
      to: ok ? "FAILED" : "UNCHANGED",
      detail: ok ? "no nonce, no broadcast" : "row moved underneath us",
    };
  }

  // Both counters must be at or below the pinned nonce: `latest` proves
  // nothing was mined at it, `pending` proves nothing is sitting in the
  // mempool waiting to be. Only then is "the broadcast never landed" a fact
  // rather than a hope — and only then may this row become re-approvable.
  if (nonces.minedNonce <= row.nonce && nonces.pendingNonce <= row.nonce) {
    const ok = await markFailedBeforeBroadcast(
      row.id,
      row.status,
      `nonce ${row.nonce} unconsumed on chain (mined=${nonces.minedNonce}, pending=${nonces.pendingNonce}); broadcast never landed`,
    );
    return {
      payoutId: row.id,
      from: row.status,
      to: ok ? "FAILED" : "UNCHANGED",
      detail: ok
        ? `nonce ${row.nonce} unconsumed; safe for a human to re-approve`
        : "row moved underneath us",
    };
  }

  // The nonce was consumed and we never recorded a hash. Try the direct
  // (sender, nonce) lookup; most public nodes do not implement it, which is
  // why the answer above is derived from nonce counters instead.
  let detail = `nonce ${row.nonce} consumed on chain but no hash was recorded`;
  try {
    const tx = await pub.getTransaction({
      sender: nonces.treasury,
      nonce: row.nonce,
    });
    if (tx?.hash) {
      await prisma.payout.updateMany({
        where: { id: row.id, status: { in: [...UNRESOLVED_STATUSES] } },
        data: { txHash: tx.hash },
      });
      detail = `recovered hash ${tx.hash} from (treasury, nonce ${row.nonce})`;
    }
  } catch {
    detail += " (node does not support lookup by sender+nonce)";
  }

  await prisma.payout.updateMany({
    where: { id: row.id, status: "SENDING" },
    data: { status: "NEEDS_RECONCILIATION", failReason: detail },
  });
  return {
    payoutId: row.id,
    from: row.status,
    to: "NEEDS_RECONCILIATION",
    detail,
  };
}
