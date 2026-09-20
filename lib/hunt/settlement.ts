// Settling a PENDING redemption on chain — the effectful half.
//
// `lib/hunt/settle.ts` decides WHAT must happen (wrap / approve / pay);
// this performs it and records the outcome. Split for the same reason
// credit.ts and redeem.ts are pure: the decision has to be unit-testable and
// recomputable, the broadcast cannot be.
//
// ## Why this is not part of POST /api/redeem
//
// Redeeming debits credit inside a database transaction. Settling broadcasts
// three transactions that can each fail, stall, or land after a timeout. If
// the two were one operation, a chain failure would have to roll back a
// committed debit — or worse, silently keep the credit spent. Keeping them
// apart means a failed settlement leaves the row PENDING and retryable, which
// is the state it was designed for: "the months are owed to the player".
//
// ## Nonce safety
//
// The settler IS the hunt treasury, the same wallet payouts broadcast from.
// Every send here therefore goes through `enqueueTreasuryOp`, the per-process
// serialiser in payout.ts. Without it a settlement and a payout can read the
// same pending nonce and replace each other.

import { createPublicClient, createWalletClient, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { prisma } from "@/lib/db/prisma";
import { monad } from "@/lib/monad";
import { toWei } from "@/lib/wei";
import { enqueueTreasuryOp } from "@/lib/hunt/payout";
import { TIERS, isTierName, readTierPriceWei } from "@/lib/hunt/cohort";
import { planSettlement, explainSettleRefusal } from "@/lib/hunt/settle";

const WMON_ABI = parseAbi([
  "function deposit() payable",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const COHORT_ABI = parseAbi(["function payMonthlyFor(address,uint8)"]);

/** MON left unwrapped so the wrap itself can pay for gas. Monad charges on the
 *  gas LIMIT with no refund, so this is a real floor, not a cushion. */
const GAS_RESERVE_WEI = 10n ** 18n;

export interface SettleResult {
  ok: boolean;
  txHash?: string;
  error?: string;
  /** True when a broadcast may have landed but the outcome is unknown. The row
   *  is left PENDING; a human resolves it. Nothing may blindly retry. */
  needsReconciliation?: boolean;
}

function rpcUrl(): string {
  return process.env.MONAD_RPC_URL ?? "https://rpc.monad.xyz";
}
function publicClient() {
  return createPublicClient({ chain: monad, transport: http(rpcUrl()) });
}
function settlerWallet() {
  const pk = process.env.HUNT_TREASURY_PRIVATE_KEY;
  if (!pk) throw new Error("HUNT_TREASURY_PRIVATE_KEY not set");
  return createWalletClient({
    account: privateKeyToAccount(pk as Hex),
    chain: monad,
    transport: http(rpcUrl()),
  });
}
function cohortAddress(): `0x${string}` | null {
  const raw = process.env.NEXT_PUBLIC_TURBO_COHORT_ADDRESS;
  return raw && /^0x[0-9a-fA-F]{40}$/.test(raw) ? (raw as `0x${string}`) : null;
}
function wmonAddress(): `0x${string}` | null {
  const raw = process.env.WMON_ADDRESS ?? process.env.NEXT_PUBLIC_WMON_ADDRESS;
  return raw && /^0x[0-9a-fA-F]{40}$/.test(raw) ? (raw as `0x${string}`) : null;
}

export async function settleRedemption(redemptionId: string, adminId: string): Promise<SettleResult> {
  return enqueueTreasuryOp(() => settleRedemptionSerial(redemptionId, adminId));
}

async function settleRedemptionSerial(redemptionId: string, adminId: string): Promise<SettleResult> {
  const cohort = cohortAddress();
  const wmon = wmonAddress();
  if (!cohort) return { ok: false, error: "NEXT_PUBLIC_TURBO_COHORT_ADDRESS not set" };
  if (!wmon) return { ok: false, error: "WMON_ADDRESS not set" };

  const r = await prisma.redemption.findUnique({
    where: { id: redemptionId },
    include: { player: true },
  });
  if (!r) return { ok: false, error: "redemption not found" };
  if (r.status !== "PENDING") return { ok: false, error: `redemption is ${r.status}, not PENDING` };
  if (!isTierName(r.tier)) return { ok: false, error: `unknown tier "${r.tier}"` };

  // Parse before claiming anything, so a malformed row fails loudly while it is
  // still PENDING rather than wedging in an in-flight state.
  let costWei: bigint;
  try {
    costWei = toWei(r.costCreditWei);
  } catch (e) {
    return { ok: false, error: `unparseable cost: ${e instanceof Error ? e.message : String(e)}` };
  }

  // Price is re-read from chain rather than trusted from the row: the snapshot
  // records what the credit was spent at, but the cohort charges today's price.
  // Settling against a stale number would under- or over-pay.
  const livePriceWei = await readTierPriceWei(r.tier);
  if (livePriceWei === null) return { ok: false, error: "no_price" };
  const dueWei = livePriceWei * BigInt(r.months);

  const pub = publicClient();
  const wallet = settlerWallet();
  const settler = wallet.account.address;
  const player = r.player.walletAddress as `0x${string}`;

  const [wmonHeldWei, allowanceWei, nativeHeldWei] = await Promise.all([
    pub.readContract({ address: wmon, abi: WMON_ABI, functionName: "balanceOf", args: [settler] }),
    pub.readContract({ address: wmon, abi: WMON_ABI, functionName: "allowance", args: [settler, cohort] }),
    pub.getBalance({ address: settler }),
  ]);

  const plan = planSettlement({
    costWei: dueWei,
    wmonHeldWei,
    allowanceWei,
    nativeHeldWei,
    gasReserveWei: GAS_RESERVE_WEI,
  });
  if (!plan.ok) return { ok: false, error: explainSettleRefusal(plan.reason) };

  let payHash: string | undefined;
  try {
    for (const step of plan.steps) {
      if (step.kind === "WRAP") {
        const h = await wallet.writeContract({ address: wmon, abi: WMON_ABI, functionName: "deposit", value: step.amountWei });
        await pub.waitForTransactionReceipt({ hash: h });
      } else if (step.kind === "APPROVE") {
        const h = await wallet.writeContract({ address: wmon, abi: WMON_ABI, functionName: "approve", args: [cohort, step.amountWei] });
        await pub.waitForTransactionReceipt({ hash: h });
      } else {
        // The irreversible one. Everything before this is recoverable: an
        // unused wrap leaves WMON in the settler, an unused approval expires
        // when it is spent or re-set.
        payHash = await wallet.writeContract({
          address: cohort,
          abi: COHORT_ABI,
          functionName: "payMonthlyFor",
          args: [player, TIERS[r.tier]],
        });
        const receipt = await pub.waitForTransactionReceipt({ hash: payHash as Hex });
        if (receipt.status !== "success") {
          return { ok: false, txHash: payHash, error: "payMonthlyFor reverted" };
        }
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // If the PAY was broadcast we do not know whether it landed. Leave the row
    // PENDING and say so — a blind retry is how somebody gets two months.
    return payHash
      ? { ok: false, txHash: payHash, needsReconciliation: true, error: `outcome unknown: ${msg}` }
      : { ok: false, error: msg };
  }

  // Claim the row only after the chain confirmed. Conditional on PENDING so two
  // operators settling at once resolve in the database, not in a race here.
  const claimed = await prisma.redemption.updateMany({
    where: { id: redemptionId, status: "PENDING" },
    data: {
      status: "SETTLED",
      settledBy: adminId,
      settledAt: new Date(),
      settlementNote: `payMonthlyFor tx=${payHash}`,
    },
  });
  if (claimed.count === 0) {
    // Paid on chain but somebody else marked the row first. Report it loudly:
    // the player has their month, but the ledger needs a human to look.
    return { ok: false, txHash: payHash, needsReconciliation: true, error: "row was settled concurrently" };
  }

  return { ok: true, txHash: payHash };
}
