// Anchor a signed Cota to Monad — the on-chain leg of the leash.
//
// A signed Cota is a self-verifying DB row (see app/api/cota/route.ts). This
// module makes it VERIFIABLE BY ANYONE: it writes the leash digest to
// AuditAnchorV2, an append-only, per-anchorer, prevHash-chained log
// (0x8422b555…, mainnet 143). After anchoring, the claim "this bound was
// authorised" no longer rests on trusting our table — it rests on a chain
// event: Anchored(anchorer, orderHash=digest, sequence, prevHash, execCommitment).
//
// Design decisions, per the house rules:
//   • DEDICATED anchorer key (COTA_ANCHOR_PRIVATE_KEY), NEVER the payout
//     treasury. Sharing that wallet's nonce with real-money MON payouts is
//     exactly the double-send class lib/hunt/payout.ts exists to prevent.
//     A distinct key also gives Cota its own clean per-anchorer chain.
//   • Anchoring is a SEPARATE act from signing (schema comment on Cota.
//     anchorTxHash). A failure here NEVER fails the sign — the caller swallows
//     it and the row simply stays un-anchored until re-tried.
//   • Serialised in-process: one anchorer address means one monotonic sequence
//     AND one wallet nonce; concurrent anchors would race both. The queue makes
//     signs anchor one at a time; a cross-instance race is caught by the
//     SequenceMismatch retry and the AlreadyAnchored idempotency check.

import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad } from "@/lib/monad";

export const AUDIT_ANCHOR_ADDRESS =
  "0x8422b555DCE11913A4657C2f47C839637FC71ffd" as const;

export const AUDIT_ANCHOR_ABI = [
  {
    name: "anchor",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "orderHash", type: "bytes32" },
      { name: "execCommitment", type: "bytes32" },
      { name: "expectedSequence", type: "uint64" },
    ],
    outputs: [{ name: "sequence", type: "uint64" }],
  },
  {
    name: "nextSequence",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    name: "execCommitmentOf",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "", type: "address" },
      { name: "", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

function rpcUrl(): string {
  return process.env.MONAD_RPC_URL || "https://rpc.monad.xyz";
}

function anchorKey(): Hex | null {
  const k = process.env.COTA_ANCHOR_PRIVATE_KEY?.trim();
  if (!k) return null;
  return (k.startsWith("0x") ? k : `0x${k}`) as Hex;
}

export type AnchorResult =
  | { txHash: `0x${string}`; sequence: number }
  | { alreadyAnchored: true }
  | { disabled: true }
  | null;

// One anchorer, one sequence, one nonce — so anchors from this process run
// strictly one after another. `.catch` keeps the chain alive past a failure.
let queue: Promise<unknown> = Promise.resolve();

export async function anchorCota(
  digest: string,
  signature: string,
): Promise<AnchorResult> {
  const key = anchorKey();
  if (!key) {
    console.warn(
      "[cota/anchor] COTA_ANCHOR_PRIVATE_KEY unset — anchoring disabled, sign stored un-anchored",
    );
    return { disabled: true };
  }
  const run = queue.then(() => doAnchor(key, digest, signature));
  queue = run.catch(() => undefined);
  return run;
}

async function doAnchor(
  key: Hex,
  digest: string,
  signature: string,
): Promise<AnchorResult> {
  const account = privateKeyToAccount(key);
  const pub = createPublicClient({ chain: monad, transport: http(rpcUrl()) });
  const wallet = createWalletClient({
    account,
    chain: monad,
    transport: http(rpcUrl()),
  });

  const orderHash = digest as `0x${string}`;
  // Bind the actual ECDSA signature into the on-chain record: the anchor then
  // commits to WHAT was signed (digest) and THAT it was signed (this sig).
  const execCommitment = keccak256(signature as `0x${string}`);

  // Idempotent: the contract reverts AlreadyAnchored, but check first so a
  // re-sign of the same bound returns cleanly instead of throwing.
  const existing = (await pub.readContract({
    address: AUDIT_ANCHOR_ADDRESS,
    abi: AUDIT_ANCHOR_ABI,
    functionName: "execCommitmentOf",
    args: [account.address, orderHash],
  })) as `0x${string}`;
  if (existing && existing !== ZERO_BYTES32) {
    return { alreadyAnchored: true };
  }

  // Two attempts: a concurrent anchorer (another instance) can take our
  // sequence between the read and the send — re-read and try once more.
  for (let attempt = 0; attempt < 2; attempt++) {
    const seq = (await pub.readContract({
      address: AUDIT_ANCHOR_ADDRESS,
      abi: AUDIT_ANCHOR_ABI,
      functionName: "nextSequence",
      args: [account.address],
    })) as bigint;
    try {
      const hash = await wallet.writeContract({
        address: AUDIT_ANCHOR_ADDRESS,
        abi: AUDIT_ANCHOR_ABI,
        functionName: "anchor",
        args: [orderHash, execCommitment, seq],
      });
      const receipt = await pub.waitForTransactionReceipt({
        hash,
        timeout: 20_000,
      });
      if (receipt.status !== "success") throw new Error("anchor tx reverted");
      return { txHash: hash, sequence: Number(seq) };
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/AlreadyAnchored/i.test(msg)) return { alreadyAnchored: true };
      if (attempt === 0 && /SequenceMismatch|sequence/i.test(msg)) continue;
      throw e;
    }
  }
  return null;
}
