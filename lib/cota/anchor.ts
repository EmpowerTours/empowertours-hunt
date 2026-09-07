// Anchor a signed Cota to Monad — the on-chain leg of the leash.
//
// A signed Cota is a self-verifying DB row (see app/api/cota/route.ts). This
// module makes it VERIFIABLE BY ANYONE: it writes the leash digest to
// AuditAnchorV2, an append-only, per-anchorer, prevHash-chained log
// (0x8422b555…, mainnet 143). After anchoring, "this bound was authorised" no
// longer rests on trusting our table — it rests on a chain event:
// Anchored(anchorer, orderHash=digest, sequence, prevHash, execCommitment).
//
// HUNTER-ANCHORED. The hunter anchors their OWN leash from their OWN Mera
// wallet, in the SAME passkey session as the signature (one Face ID — both are
// local key ops), paying the small MON fee themselves. This means:
//   • Each hunter's leashes chain under THEIR address — their own on-chain
//     record, not a shared one.
//   • No platform anchorer wallet, so nothing can share a nonce with the MON
//     payout treasury (the double-send class lib/hunt/payout.ts guards).
// Anchoring is a SEPARATE act from signing (schema comment on Cota.
// anchorTxHash): a failure here never invalidates the signed leash.

import {
  keccak256,
  parseEventLogs,
  type Hex,
  type LocalAccount,
} from "viem";
import { publicClient, walletClientFor } from "@/lib/cota/swap";

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
  {
    type: "event",
    name: "Anchored",
    inputs: [
      { name: "anchorer", type: "address", indexed: true },
      { name: "orderHash", type: "bytes32", indexed: true },
      { name: "sequence", type: "uint64", indexed: true },
      { name: "prevHash", type: "bytes32", indexed: false },
      { name: "execCommitment", type: "bytes32", indexed: false },
    ],
  },
] as const;

const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

export type AnchorResult =
  | { txHash: `0x${string}`; sequence: number }
  | { alreadyAnchored: true };

/**
 * Anchor a leash from the hunter's own wallet. Call inside the passkey session
 * that produced `signature`, using the same `account` — one Face ID covers both
 * the signature and this transaction, because both are local key operations.
 *
 * The caller treats any throw as best-effort: the leash is signed regardless.
 */
export async function anchorLeashWithAccount(
  account: LocalAccount,
  digest: Hex,
  signature: Hex,
): Promise<AnchorResult> {
  const pub = publicClient();
  // Bind the actual ECDSA signature into the on-chain record: the anchor then
  // commits to WHAT was signed (digest) and THAT it was signed (this sig).
  const execCommitment = keccak256(signature);

  // Idempotent: the contract reverts AlreadyAnchored, but check first so a
  // re-sign of the same bound resolves cleanly instead of throwing.
  const existing = (await pub.readContract({
    address: AUDIT_ANCHOR_ADDRESS,
    abi: AUDIT_ANCHOR_ABI,
    functionName: "execCommitmentOf",
    args: [account.address, digest],
  })) as `0x${string}`;
  if (existing && existing !== ZERO_BYTES32) {
    return { alreadyAnchored: true };
  }

  // Two attempts: this hunter signing two leashes in quick succession could
  // race their own sequence — re-read and try once more.
  for (let attempt = 0; attempt < 2; attempt++) {
    const seq = (await pub.readContract({
      address: AUDIT_ANCHOR_ADDRESS,
      abi: AUDIT_ANCHOR_ABI,
      functionName: "nextSequence",
      args: [account.address],
    })) as bigint;
    try {
      const hash = await walletClientFor(account).writeContract({
        address: AUDIT_ANCHOR_ADDRESS,
        abi: AUDIT_ANCHOR_ABI,
        functionName: "anchor",
        args: [digest, execCommitment, seq],
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
  throw new Error("anchor failed after retry");
}

/**
 * Server-side: confirm a client-reported anchor tx really anchored THIS digest
 * from THIS player, before the row records it. Anchoring is trust-minimising —
 * storing a hash the client merely claimed would undercut that. Returns false
 * (never throws) so a verification hiccup just leaves the row un-anchored.
 */
export async function verifyAnchorTx(
  txHash: Hex,
  digest: Hex,
  playerAddress: string,
): Promise<boolean> {
  try {
    const receipt = await publicClient().getTransactionReceipt({
      hash: txHash,
    });
    if (receipt.status !== "success") return false;
    const events = parseEventLogs({
      abi: AUDIT_ANCHOR_ABI,
      logs: receipt.logs,
      eventName: "Anchored",
    });
    return events.some(
      (e) =>
        e.address.toLowerCase() === AUDIT_ANCHOR_ADDRESS.toLowerCase() &&
        (e.args.orderHash as string).toLowerCase() === digest.toLowerCase() &&
        (e.args.anchorer as string).toLowerCase() ===
          playerAddress.toLowerCase(),
    );
  } catch {
    return false;
  }
}
