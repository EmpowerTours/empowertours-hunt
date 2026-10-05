// Recovering a licence the relayer bought and never delivered.
//
// WHY THIS EXISTS. relayLicense does two transactions: `purchase`, then
// `transferFrom`. Between them the money is already spent and the licence sits
// at the relayer. Anything that throws in that gap — an RPC hiccup, a dropped
// connection, a node that will not serve the receipt's logs — leaves the
// hunter with nothing and the relayer holding a token it paid for. The claim
// row records this honestly (status FAILED, purchaseTxHash set, transferTxHash
// null) and then nothing ever acted on it.
//
// Found by running the real relayer against a Tenderly fork of Monad mainnet:
// the purchase succeeded, the log read failed, and 35 MON of licence stayed
// with the relayer. On a 300 MON edition that is a meaningful amount to strand
// on a transient error.
//
// THE DECISION IS A PURE FUNCTION. `decideSweep` takes what the chain says and
// returns what to do, with no client and no database. Everything that could
// send a transaction twice is decided there, where it can be tested.

import type { Address, Hex } from "viem";

/** What the sweeper should do with one stranded claim. */
export type SweepOutcome =
  /** The relayer holds it and the recipient is known: send it on. */
  | { act: "transfer"; licenseId: bigint }
  /** The recipient already has it. Nothing to do but correct the row. */
  | { act: "already_delivered"; licenseId: bigint }
  /**
   * Someone other than the relayer and the recipient holds it. DO NOT act:
   * the relayer cannot transfer what it does not own, and a token that moved
   * somewhere unexpected is a thing to look at, not to automate around.
   */
  | { act: "not_held"; licenseId: bigint; owner: string }
  /** The purchase happened but no licence id was ever recorded or recovered. */
  | { act: "needs_license_id" };

const eq = (a: string | null | undefined, b: string | null | undefined) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();

/**
 * Decide the fate of one stranded claim from on-chain facts alone.
 *
 * `owner` is what `ownerOf(licenseId)` returned, or null when it could not be
 * read. A null owner never produces a transfer: acting on an unknown owner is
 * how a sweeper sends a token twice.
 */
export function decideSweep(args: {
  licenseId: bigint | null;
  owner: string | null;
  relayer: string;
  recipient: string;
}): SweepOutcome {
  const { licenseId, owner, relayer, recipient } = args;
  if (licenseId === null) return { act: "needs_license_id" };
  // Checked BEFORE the relayer case. If the recipient already holds it the
  // delivery happened — by an earlier sweep, a manual send, or a transfer
  // whose receipt we failed to read — and re-sending is impossible anyway.
  if (eq(owner, recipient)) return { act: "already_delivered", licenseId };
  if (eq(owner, relayer)) return { act: "transfer", licenseId };
  return { act: "not_held", licenseId, owner: owner ?? "unknown" };
}

/** One claim worth examining: paid for, never delivered. */
export interface StrandedClaim {
  id: string;
  /** Null when the purchase succeeded but the id was never read from logs. */
  licenseId: string | null;
  purchaseTxHash: string;
  /** Where the licence was always meant to go. */
  walletAddress: string;
  collection: string;
}

/**
 * Pull the licence id out of a purchase receipt's logs.
 *
 * Needed because the id is not always on the row: the failure that prompted
 * this module was a node refusing `eth_getLogs` by blockHash, which happens
 * AFTER the purchase and before the id is recorded. The id is recoverable from
 * the receipt forever, so a claim is never unrecoverable merely because the
 * first read failed.
 *
 * Takes already-fetched logs rather than a client, so the parsing is testable.
 */
export function licenseIdFromLogs(
  logs: { topics: readonly Hex[]; address: string }[],
  salesController: string,
  buyer: string,
): bigint | null {
  // LicensePurchased(uint256 indexed licenseId, uint256 indexed masterTokenId,
  //                  address indexed buyer, uint256 price, bool isCollector)
  const TOPIC0 =
    "0xcd9b3a3c6d5b7c3e7dcf67d99c3778fcb5be4250ef5f2e547d87e99b7695394f";
  for (const log of logs) {
    if (!eq(log.address, salesController)) continue;
    if (log.topics.length < 4) continue;
    if (log.topics[0]?.toLowerCase() !== TOPIC0) continue;
    // topic3 is the indexed buyer, left-padded to 32 bytes.
    const topicBuyer = `0x${log.topics[3]!.slice(-40)}`;
    if (!eq(topicBuyer, buyer)) continue;
    return BigInt(log.topics[1]!);
  }
  return null;
}

export interface SweepReport {
  examined: number;
  transferred: { claimId: string; licenseId: string; txHash: Address }[];
  alreadyDelivered: string[];
  notHeld: { claimId: string; owner: string }[];
  unresolved: { claimId: string; reason: string }[];
}

export function emptyReport(): SweepReport {
  return {
    examined: 0,
    transferred: [],
    alreadyDelivered: [],
    notHeld: [],
    unresolved: [],
  };
}

// --- The executor --------------------------------------------------------
//
// Everything above is pure. This part talks to the chain and the database, and
// it is deliberately thin: it gathers facts, hands them to decideSweep, and
// does only what comes back.

import { createPublicClient, parseAbi } from "viem";
import { monad, monadRpcUrl, monadTransport } from "@/lib/monad";
import { prisma } from "@/lib/db/prisma";
import { relayerConfig, enqueueRelayerOp } from "./relayer";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient } from "viem";

const OWNER_ABI = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function transferFrom(address from, address to, uint256 tokenId)",
]);

/**
 * Find licences the relayer paid for and never delivered, and deliver them.
 *
 * DRY BY DEFAULT. `execute` must be passed explicitly, because this spends the
 * relayer's gas and moves assets. A sweeper that sends by default is one typo
 * away from being a very expensive cron job.
 *
 * Shares the relayer's serial nonce queue — a sweep transfer racing a live
 * claim onto the same nonce is the exact failure that queue exists to stop.
 */
export async function sweepStrandedLicences(
  opts: { limit?: number; execute?: boolean } = {},
): Promise<SweepReport> {
  const limit = opts.limit ?? 10;
  const execute = opts.execute === true;
  const report = emptyReport();

  const cfg = relayerConfig();
  if (!cfg) {
    report.unresolved.push({ claimId: "-", reason: "relayer not configured" });
    return report;
  }

  // Paid for, never delivered. `transferTxHash: null` is the whole definition:
  // a row with one is finished regardless of what its status says.
  const rows = await prisma.editionClaim.findMany({
    where: {
      status: "FAILED",
      purchaseTxHash: { not: null },
      transferTxHash: null,
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      id: true,
      licenseId: true,
      purchaseTxHash: true,
      walletAddress: true,
      collection: true,
    },
  });
  report.examined = rows.length;
  if (rows.length === 0) return report;

  const pub = createPublicClient({
    chain: monad,
    transport: monadTransport(),
  });

  for (const row of rows) {
    try {
      // The id may be absent: the failure this module was built for happens
      // after the purchase and before the id is read. It stays recoverable
      // from the receipt forever.
      let licenseId: bigint | null =
        row.licenseId === null ? null : BigInt(row.licenseId);
      if (licenseId === null && row.purchaseTxHash !== null) {
        const receipt = await pub.getTransactionReceipt({
          hash: row.purchaseTxHash as `0x${string}`,
        });
        licenseId = licenseIdFromLogs(
          receipt.logs.map((l) => ({ topics: l.topics, address: l.address })),
          cfg.salesController,
          cfg.relayerAddress,
        );
      }

      let owner: string | null = null;
      if (licenseId !== null) {
        owner = (await pub
          .readContract({
            address: row.collection as `0x${string}`,
            abi: OWNER_ABI,
            functionName: "ownerOf",
            args: [licenseId],
          })
          .catch(() => null)) as string | null;
      }

      const decision = decideSweep({
        licenseId,
        owner,
        relayer: cfg.relayerAddress,
        recipient: row.walletAddress,
      });

      if (decision.act === "needs_license_id") {
        report.unresolved.push({
          claimId: row.id,
          reason:
            "licence id not on the row and not recoverable from the receipt",
        });
        continue;
      }
      if (decision.act === "not_held") {
        report.notHeld.push({ claimId: row.id, owner: decision.owner });
        continue;
      }
      if (decision.act === "already_delivered") {
        report.alreadyDelivered.push(row.id);
        if (execute) {
          // The token is where it belongs; only the row was wrong.
          await prisma.editionClaim.update({
            where: { id: row.id },
            data: {
              status: "SENT",
              licenseId: decision.licenseId.toString(),
              failReason: null,
            },
          });
        }
        continue;
      }

      if (!execute) {
        report.transferred.push({
          claimId: row.id,
          licenseId: decision.licenseId.toString(),
          txHash: "0xdryrun" as `0x${string}`,
        });
        continue;
      }

      const account = privateKeyToAccount(cfg.privateKey);
      const wallet = createWalletClient({
        account,
        chain: monad,
        transport: monadTransport(),
      });
      const txHash = await enqueueRelayerOp(() =>
        wallet.writeContract({
          address: row.collection as `0x${string}`,
          abi: OWNER_ABI,
          functionName: "transferFrom",
          args: [
            account.address,
            row.walletAddress as `0x${string}`,
            decision.licenseId,
          ],
        }),
      );
      const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") {
        report.unresolved.push({
          claimId: row.id,
          reason: `transfer reverted: ${txHash}`,
        });
        continue;
      }
      // Written only after the receipt says success. A row marked SENT on a
      // reverted transfer is worse than one left FAILED: the next sweep would
      // skip it and the hunter would never be paid.
      await prisma.editionClaim.update({
        where: { id: row.id },
        data: {
          status: "SENT",
          transferTxHash: txHash,
          licenseId: decision.licenseId.toString(),
          failReason: null,
        },
      });
      report.transferred.push({
        claimId: row.id,
        licenseId: decision.licenseId.toString(),
        txHash,
      });
    } catch (e) {
      report.unresolved.push({
        claimId: row.id,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return report;
}
