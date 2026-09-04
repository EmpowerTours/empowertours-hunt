import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad } from "@/lib/monad";

// ---------------------------------------------------------------------------
// The relayer that gives a "Dime Que Sí" licence away for free.
//
// The music v3 SalesController refuses a zero price (ZeroPrice), so "free" is
// not a contract setting — it is this flow: a funded hot wallet BUYS the
// licence at the nominal standard price and TRANSFERS it to the claimer, who
// pays no gas and holds no WMON. Because the artist and treasury on that master
// are both us, the nominal WMON round-trips; the real cost is gas on two
// transactions.
//
// ## Bounded by construction
//
// The relayer wallet holds only what we are willing to give away — its WMON
// balance and its MON gas are the hard ceiling on the whole giveaway, on chain,
// independent of any app bug. A drained relayer stops working; it cannot
// overspend a treasury it does not hold.
//
// ## Serial, because one wallet has one nonce
//
// Every relayer send goes through one in-process queue. Two concurrent claims
// would otherwise read the same nonce and collide, and a replaced transaction
// is how one claim becomes two licences or a stuck nonce. Same pattern as the
// payout treasury queue.
// ---------------------------------------------------------------------------

const SALES_ABI = parseAbi([
  "function purchase(uint256 masterTokenId, bool isCollector, string uri) returns (uint256)",
  "event LicensePurchased(uint256 indexed licenseId, uint256 indexed masterTokenId, address indexed buyer, uint256 price, bool isCollector)",
]);

const LICENSE_ABI = parseAbi([
  "function transferFrom(address from, address to, uint256 tokenId)",
]);

export interface RelayerConfig {
  privateKey: Hex;
  salesController: Address;
  licenseRegistry: Address;
  masterId: bigint;
  /** Licence metadata uri, passed straight to purchase(). */
  licenseUri: string;
}

/**
 * Read the relayer configuration, or null when the giveaway is not wired up.
 *
 * Null rather than throwing: a deployment without the drop configured should
 * run normally, with the claim route reporting "not available" rather than
 * crashing. Every value must be present — a half-configured relayer that could
 * buy but not transfer would strand licences in the hot wallet.
 */
export function relayerConfig(): RelayerConfig | null {
  const privateKey = process.env.DIME_RELAYER_PRIVATE_KEY;
  const salesController = process.env.DIME_SALES_CONTROLLER;
  const licenseRegistry = process.env.DIME_LICENSE_REGISTRY;
  const masterId = process.env.DIME_MASTER_ID;
  const licenseUri = process.env.DIME_LICENSE_URI ?? "";

  if (
    !privateKey ||
    !/^0x[0-9a-fA-F]{64}$/.test(privateKey) ||
    !salesController ||
    !/^0x[0-9a-fA-F]{40}$/.test(salesController) ||
    !licenseRegistry ||
    !/^0x[0-9a-fA-F]{40}$/.test(licenseRegistry) ||
    !masterId ||
    !/^\d+$/.test(masterId)
  ) {
    return null;
  }

  return {
    privateKey: privateKey as Hex,
    salesController: salesController as Address,
    licenseRegistry: licenseRegistry as Address,
    masterId: BigInt(masterId),
    licenseUri,
  };
}

// One queue per process. See the note above about nonces.
let relayerQueue: Promise<unknown> = Promise.resolve();
function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const run = relayerQueue.then(op, op);
  // Swallow so one rejection does not wedge every later send.
  relayerQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export interface RelayResult {
  ok: boolean;
  licenseId?: string;
  purchaseTxHash?: string;
  transferTxHash?: string;
  error?: string;
}

/**
 * Buy one licence and transfer it to `recipient`. Serial, awaited end to end.
 *
 * The purchase is confirmed before the transfer is attempted: transferring a
 * token id parsed from an unconfirmed purchase is how a licence is sent that
 * does not exist yet. Failure at either step returns `ok: false` and never
 * throws past the queue — the caller records the failure and the claimer is
 * told to try again, rather than the row being left in a state nobody can read.
 */
export function relayFreeLicense(
  cfg: RelayerConfig,
  recipient: Address,
): Promise<RelayResult> {
  return enqueue(async () => {
    const account = privateKeyToAccount(cfg.privateKey);
    const transport = http(process.env.MONAD_RPC_URL);
    const wallet = createWalletClient({ account, chain: monad, transport });
    const pub = createPublicClient({ chain: monad, transport });

    let purchaseTxHash: string | undefined;
    let licenseId: bigint | undefined;
    try {
      const hash = await wallet.writeContract({
        address: cfg.salesController,
        abi: SALES_ABI,
        functionName: "purchase",
        args: [cfg.masterId, false, cfg.licenseUri],
      });
      purchaseTxHash = hash;
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        return { ok: false, purchaseTxHash, error: "purchase reverted" };
      }
      // The licence id from the event, not a guess. The relayer is the buyer,
      // so its LicensePurchased log carries the id just minted to it.
      const decoded = await pub.getContractEvents({
        address: cfg.salesController,
        abi: SALES_ABI,
        eventName: "LicensePurchased",
        blockHash: receipt.blockHash,
      });
      void receipt;
      const mine = decoded.find(
        (e) =>
          e.transactionHash?.toLowerCase() === hash.toLowerCase() &&
          e.args.buyer?.toLowerCase() === account.address.toLowerCase(),
      );
      licenseId = mine?.args.licenseId;
      if (licenseId === undefined) {
        return {
          ok: false,
          purchaseTxHash,
          error: "purchase succeeded but licence id not found in logs",
        };
      }
    } catch (err) {
      return {
        ok: false,
        purchaseTxHash,
        error: `purchase failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    try {
      const transferHash = await wallet.writeContract({
        address: cfg.licenseRegistry,
        abi: LICENSE_ABI,
        functionName: "transferFrom",
        args: [account.address, recipient, licenseId],
      });
      const receipt = await pub.waitForTransactionReceipt({
        hash: transferHash,
      });
      if (receipt.status !== "success") {
        return {
          ok: false,
          licenseId: licenseId.toString(),
          purchaseTxHash,
          transferTxHash: transferHash,
          error: "transfer reverted — licence is held by the relayer",
        };
      }
      return {
        ok: true,
        licenseId: licenseId.toString(),
        purchaseTxHash,
        transferTxHash: transferHash,
      };
    } catch (err) {
      // The licence exists and is in the relayer wallet. Recoverable by hand,
      // and recorded as such, but the claimer's automatic flow failed.
      return {
        ok: false,
        licenseId: licenseId.toString(),
        purchaseTxHash,
        error: `bought but transfer failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });
}
