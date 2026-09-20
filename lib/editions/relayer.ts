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
// The relayer that puts an fcempowertours licence into a hunter's wallet.
//
// Generalised 2026-09-20 from a single hardcoded song ("Dime Que Sí") to any
// master in the v3 registry — music or art, free or paid. The master is now a
// PER-CALL argument rather than an env var, because which work a hunter found
// is decided by the edition draw, not by deployment configuration.
//
// The v3 SalesController refuses a zero price (ZeroPrice), so "free" is not a
// contract setting — it is this flow: a funded hot wallet BUYS the licence and
// TRANSFERS it to the hunter, who pays no gas, holds no WMON and grants no
// allowance. That last part is not incidental: the v3 audit's critical finding
// was bounded by "the victim's outstanding WMON allowance", so the design that
// never creates one on a player's wallet cannot inherit the shape of it.
//
// Who actually pays depends on the terms, and this module does not decide:
//   FREE      the relayer's own balance, and the nominal WMON round-trips when
//             the artist and treasury on that master are both us.
//   PURCHASE  the hunter's unwithdrawn hunt earnings, debited by the caller
//             BEFORE this runs. This module only ever spends relayer funds; it
//             is the caller's job to have taken the money first and to put it
//             back if `ok` comes out false.
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

const PRICING_ABI = parseAbi([
  "function pricing(uint256) view returns (uint256 price, uint256 collectorPrice, bool salesPaused)",
]);

const LICENSE_ABI = parseAbi([
  "function transferFrom(address from, address to, uint256 tokenId)",
]);

export interface RelayerConfig {
  privateKey: Hex;
  /**
   * The relayer's public address, derived from the key at config time.
   *
   * This is what a hunter sends their payment TO, so it has to reach the
   * client — which is exactly why it is derived here rather than left for a
   * caller to work out from the key. A caller that needed the key to learn
   * the address would be a caller holding the key for no other reason.
   */
  relayerAddress: Address;
  salesController: Address;
  /**
   * The registry this relayer is wired to. An Edition row carries its own
   * `collection`, and `relayLicense` REFUSES when the two disagree — buying
   * from one registry and transferring from another is how a licence goes to
   * nobody, and a mismatch means the catalogue read and the deployment have
   * drifted.
   */
  licenseRegistry: Address;
}

/** Which work to buy. Supplied per call, from the Edition the hunter took. */
export interface LicenseOrder {
  /** Must equal the configured licenseRegistry. Checked, not assumed. */
  collection: Address;
  masterId: bigint;
  /**
   * Which tier to buy — `purchase()`'s own `isCollector` flag.
   *
   * Was hardcoded false when this relayer existed for one free song. It is a
   * parameter now because the two tiers are separately priced and separately
   * capped, and a giveaway of the standard licence exists precisely to sell
   * the collector one later.
   */
  isCollector: boolean;
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
  const privateKey = process.env.EDITION_RELAYER_PRIVATE_KEY;
  const salesController = process.env.EDITION_SALES_CONTROLLER;
  const licenseRegistry = process.env.EDITION_LICENSE_REGISTRY;

  if (
    !privateKey ||
    !/^0x[0-9a-fA-F]{64}$/.test(privateKey) ||
    !salesController ||
    !/^0x[0-9a-fA-F]{40}$/.test(salesController) ||
    !licenseRegistry ||
    !/^0x[0-9a-fA-F]{40}$/.test(licenseRegistry)
  ) {
    return null;
  }

  return {
    privateKey: privateKey as Hex,
    relayerAddress: privateKeyToAccount(privateKey as Hex).address,
    salesController: salesController as Address,
    licenseRegistry: licenseRegistry as Address,
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
export function relayLicense(
  cfg: RelayerConfig,
  order: LicenseOrder,
  recipient: Address,
): Promise<RelayResult> {
  return enqueue(async () => {
    // Reject by default. A row naming a registry this relayer was not
    // configured for is a drift between the catalogue and the deployment, and
    // the failure mode of guessing is a purchase from one contract and a
    // transfer attempt against another.
    if (order.collection.toLowerCase() !== cfg.licenseRegistry.toLowerCase()) {
      return {
        ok: false,
        error: `collection ${order.collection} is not this relayer's registry ${cfg.licenseRegistry}`,
      };
    }

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
        args: [order.masterId, order.isCollector, order.licenseUri],
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

/**
 * Is this work actually buyable right now, at the price we quoted?
 *
 * Called BEFORE the hunter's payment is accepted, not after the relayer tries
 * to buy. `salesPaused` lives in SalesController.pricing and is NOT exposed by
 * the catalogue endpoint, so a paused work looks perfectly offerable to hunt:
 * still active, still priced. Without this the sequence would be "take their
 * money, fail, give it back", which is a bad minute for somebody who just
 * paid and a second money movement for us.
 *
 * Also re-reads the price. The row's price is what the hunter is charged and
 * is honoured regardless — this only catches the case where the venue has
 * moved so far that the purchase could not complete at all.
 *
 * Fails CLOSED: an RPC error answers "not buyable". Refusing an offer costs a
 * hunter nothing; accepting money for something we cannot deliver costs them
 * real MON and us a refund.
 */
export async function isBuyable(
  cfg: RelayerConfig,
  masterId: bigint,
  isCollector: boolean,
  quotedWei: bigint,
): Promise<{ ok: true } | { ok: false; reason: "price_moved" }> {
  try {
    const pub = createPublicClient({
      chain: monad,
      transport: http(process.env.MONAD_RPC_URL),
    });
    const [price, collectorPrice, salesPaused] = await pub.readContract({
      address: cfg.salesController,
      abi: PRICING_ABI,
      functionName: "pricing",
      args: [masterId],
    });
    if (salesPaused) return { ok: false, reason: "price_moved" };

    const live = isCollector ? collectorPrice : price;
    // Zero reverts at the venue with ZeroPrice, so it is unbuyable whatever
    // the row says.
    if (live === 0n) return { ok: false, reason: "price_moved" };
    // Dearer than quoted means the relayer would have to make up the
    // difference out of its own balance. Cheaper is fine — the hunter is
    // charged what the card said and the surplus stays with the relayer,
    // which is the party that took the TTL risk.
    if (live > quotedWei) return { ok: false, reason: "price_moved" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "price_moved" };
  }
}
