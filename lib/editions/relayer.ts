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
  "function tokenURI(uint256 tokenId) view returns (string)",
]);

/**
 * The venue's settlement token, read from the venue rather than configured.
 *
 * `SalesController.paymentToken` is `immutable`, so one read per process is
 * the whole cost, and asking the contract removes a way for an env var to
 * disagree with the deployment it points at.
 */
const PAYMENT_TOKEN_ABI = parseAbi([
  "function paymentToken() view returns (address)",
]);

/**
 * WMON, as both an ERC-20 and a wrapper.
 *
 * `deposit()` is what makes native MON spendable at the venue. It is on this
 * ABI because the relayer is paid in MON and settles in WMON -- see the
 * funding note on `planFunding`.
 */
const WMON_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function deposit() payable",
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

/**
 * The relayer is PAID IN MON AND SETTLES IN WMON, and nothing used to bridge
 * the two.
 *
 * `SalesController.purchase` moves no value itself: `_settle` calls
 * `paymentToken.safeTransferFrom(msg.sender, ...)` once per payee. So a
 * purchase needs the relayer to hold WMON *and* to have approved the
 * controller to take it. The hunter, meanwhile, pays with a plain native
 * transfer -- see lib/editions/payment.ts for why that shape was chosen.
 *
 * Neither the wrap nor the approval existed. A relayer funded with MON and
 * nothing else would revert on the first `_pull` with an ERC-20 allowance
 * error, AFTER the hunter's payment had been verified and their claim row
 * written -- the one failure this whole module is arranged to avoid.
 *
 * ## Why it wraps per sale instead of holding a float
 *
 * The hunter's own MON has already landed in this wallet by the time a
 * purchase runs, so wrapping the shortfall converts their payment into the
 * currency the venue wants. The relayer then needs a float only for gas, not
 * for inventory, and the giveaway ceiling stays exactly what the wallet
 * holds.
 *
 * ## The reserve is not decoration
 *
 * Monad charges the FULL gas limit with no refund, so a wallet that wraps its
 * entire balance cannot afford to send the purchase it just funded -- it
 * would convert its own gas into WMON and strand itself. Measured at 102 gwei
 * on 2026-09-20: approve 60k + deposit 60k + purchase 400k + transferFrom
 * 120k is about 0.065 MON for one sale, so the default reserve is one whole
 * sale of headroom.
 */
export const DEFAULT_GAS_RESERVE_WEI = 100_000_000_000_000_000n; // 0.1 MON

/**
 * The reserve, overridable per deployment.
 *
 * Env rather than hardcoded because gas price is not a constant and the right
 * number is "one sale's worth". A malformed value falls back to the default
 * rather than to zero -- a zero reserve is exactly the stranding this guards.
 */
export function gasReserveWei(): bigint {
  const raw = process.env.EDITION_GAS_RESERVE_WEI;
  if (!raw) return DEFAULT_GAS_RESERVE_WEI;
  try {
    const v = BigInt(raw);
    return v >= 0n ? v : DEFAULT_GAS_RESERVE_WEI;
  } catch {
    return DEFAULT_GAS_RESERVE_WEI;
  }
}

/** What the relayer has, as read from the chain by the caller. */
export interface RelayerFunds {
  /** Settlement currency. What `purchase` will actually take. */
  wmonWei: bigint;
  /** Native MON. Pays gas, and is the source for any wrap. */
  nativeWei: bigint;
  /** What the relayer has already approved the SalesController to spend. */
  allowanceWei: bigint;
}

export type FundingPlan =
  | { ok: true; wrapWei: bigint; approve: boolean }
  | { ok: false; shortfallWei: bigint };

/**
 * Can this relayer settle a purchase at `priceWei`, and what has to happen
 * first?
 *
 * Pure, and exported, for the same reason `checkPayment` is: it decides
 * whether money moves, so it has to be answerable by replaying numbers rather
 * than by trusting what the wallet did on the night.
 *
 * Reject by default -- `!(a >= b)` rather than `if (a < b)`, per AGENTS.md
 * rule 2, so a nonsensical balance lands on "cannot fund" instead of slipping
 * through a comparison.
 */
export function planFunding(
  funds: RelayerFunds,
  priceWei: bigint,
  gasReserveWei: bigint = DEFAULT_GAS_RESERVE_WEI,
): FundingPlan {
  if (!(priceWei > 0n)) {
    // Zero reverts at the venue with ZeroPrice, so there is nothing to fund.
    throw new RangeError("planFunding: price must be positive");
  }
  if (!(gasReserveWei >= 0n)) {
    throw new RangeError("planFunding: negative gas reserve");
  }

  const wrapWei = funds.wmonWei >= priceWei ? 0n : priceWei - funds.wmonWei;

  // The reserve is required WHETHER OR NOT anything is wrapped: even a relayer
  // holding enough WMON still has to pay gas for purchase and transfer.
  const nativeNeeded = wrapWei + gasReserveWei;
  if (!(funds.nativeWei >= nativeNeeded)) {
    return { ok: false, shortfallWei: nativeNeeded - funds.nativeWei };
  }

  return { ok: true, wrapWei, approve: !(funds.allowanceWei >= priceWei) };
}

/**
 * The dearest work this relayer could settle right now.
 *
 * The same arithmetic as `planFunding` read from the other end, and used at
 * PLACEMENT rather than at purchase. That matters because of where the money
 * actually moves: the card signs the hunter's transfer and only THEN calls the
 * answer route, so every "before we take their money" refusal on the server is
 * in fact after it. The only check that happens before the hunter pays is the
 * one that decides whether a card is shown at all.
 *
 * Native beyond the reserve counts, because it can be wrapped.
 */
export function maxSettleableWei(
  funds: RelayerFunds,
  gasReserveWei: bigint = DEFAULT_GAS_RESERVE_WEI,
): bigint {
  const spendableNative =
    funds.nativeWei > gasReserveWei ? funds.nativeWei - gasReserveWei : 0n;
  return funds.wmonWei + spendableNative;
}

/**
 * What the relayer could settle, or null when it cannot be asked.
 *
 * Null is NOT zero: "the RPC did not answer" and "the wallet is empty" are
 * different facts, and the caller must not turn the first into "no works are
 * available" -- the same distinction the catalogue draws between unavailable
 * and exhausted.
 */
export async function relayerCapacity(
  cfg: RelayerConfig,
): Promise<bigint | null> {
  try {
    const transport = http(process.env.MONAD_RPC_URL);
    const pub = createPublicClient({ chain: monad, transport });
    const wmon = await paymentTokenOf(pub, cfg.salesController);
    const funds = await readFunds(
      pub,
      wmon,
      cfg.relayerAddress,
      cfg.salesController,
    );
    return maxSettleableWei(funds, gasReserveWei());
  } catch {
    return null;
  }
}

/** Read everything `planFunding` needs, in one batch. */
async function readFunds(
  pub: ReturnType<typeof createPublicClient>,
  wmon: Address,
  relayer: Address,
  spender: Address,
): Promise<RelayerFunds> {
  const [wmonWei, allowanceWei, nativeWei] = await Promise.all([
    pub.readContract({
      address: wmon,
      abi: WMON_ABI,
      functionName: "balanceOf",
      args: [relayer],
    }),
    pub.readContract({
      address: wmon,
      abi: WMON_ABI,
      functionName: "allowance",
      args: [relayer, spender],
    }),
    pub.getBalance({ address: relayer }),
  ]);
  return { wmonWei, allowanceWei, nativeWei };
}

/**
 * The venue's settlement token. Immutable on chain, so cached per process.
 *
 * The PROMISE is cached, not the resolved value. Caching the value meant
 * reading the cache, awaiting, then writing it -- two concurrent claims both
 * see null and both read the chain, which eslint's require-atomic-updates is
 * right to flag even though the value is immutable. Holding the promise makes
 * the assignment synchronous and collapses the duplicate read as a bonus.
 *
 * A FAILED read is never cached. Otherwise one RPC hiccup at boot would
 * poison every sale for the life of the process -- the same rule the
 * catalogue follows for the same reason.
 */
let paymentTokenCache: Promise<Address> | null = null;
function paymentTokenOf(
  pub: ReturnType<typeof createPublicClient>,
  salesController: Address,
): Promise<Address> {
  if (paymentTokenCache === null) {
    paymentTokenCache = (
      pub.readContract({
        address: salesController,
        abi: PAYMENT_TOKEN_ABI,
        functionName: "paymentToken",
      }) as Promise<Address>
    ).catch((err) => {
      paymentTokenCache = null;
      throw err;
    });
  }
  return paymentTokenCache;
}

/** Tests only. */
export function resetPaymentTokenCache(): void {
  paymentTokenCache = null;
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

    // ---- Make the wallet able to pay before asking it to.
    //
    // Inside the queue, so the wrap and the approval share the serial nonce
    // with the purchase they exist for. Doing this outside would race two
    // concurrent claims onto the same nonce -- the exact thing the queue is
    // for.
    try {
      // The LIVE price, not the quoted one. `_settle` pulls whatever
      // `pricing` says at execution time, and `isBuyable` only established
      // that it is not HIGHER than the quote -- a venue that cut its price
      // still settles at the lower number, and funding the quote would
      // over-wrap. Either way the amount approved has to be the amount taken.
      const [listPrice, collectorPrice] = (await pub.readContract({
        address: cfg.salesController,
        abi: PRICING_ABI,
        functionName: "pricing",
        args: [order.masterId],
      })) as [bigint, bigint, boolean];
      const price = order.isCollector ? collectorPrice : listPrice;
      if (!(price > 0n)) {
        return { ok: false, error: "venue quotes zero for this work" };
      }

      const wmon = await paymentTokenOf(pub, cfg.salesController);
      const funds = await readFunds(
        pub,
        wmon,
        account.address,
        cfg.salesController,
      );
      const plan = planFunding(funds, price, gasReserveWei());
      if (!plan.ok) {
        // Nothing has been attempted on chain, so this is a clean refusal.
        // The caller has already taken the hunter's money, which is why the
        // placement route refuses to offer anything an unfunded relayer
        // cannot deliver -- this is the backstop, not the gate.
        return {
          ok: false,
          error:
            `relayer cannot fund this purchase: short ${plan.shortfallWei} wei of MON ` +
            `(needs the price to wrap plus a gas reserve)`,
        };
      }
      if (plan.wrapWei > 0n) {
        const wrapHash = await wallet.writeContract({
          address: wmon,
          abi: WMON_ABI,
          functionName: "deposit",
          value: plan.wrapWei,
        });
        const r = await pub.waitForTransactionReceipt({ hash: wrapHash });
        if (r.status !== "success") {
          return { ok: false, error: "wrapping MON to WMON reverted" };
        }
      }
      if (plan.approve) {
        // Exactly what this purchase needs, not an unbounded allowance.
        // The spender is our own SalesController and the wallet is bounded by
        // its own balance either way, so an infinite approval would buy one
        // saved transaction at the price of a standing claim on a hot wallet.
        // At ~0.006 MON an approval, that trade is not worth making.
        const approveHash = await wallet.writeContract({
          address: wmon,
          abi: WMON_ABI,
          functionName: "approve",
          args: [cfg.salesController, price],
        });
        const r = await pub.waitForTransactionReceipt({ hash: approveHash });
        if (r.status !== "success") {
          return { ok: false, error: "approving WMON to the venue reverted" };
        }
      }
    } catch (err) {
      return {
        ok: false,
        error: `relayer funding failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    let purchaseTxHash: string | undefined;
    let licenseId: bigint | undefined;
    try {
      // ---- The licence uri belongs to the MASTER, not to the deployment.
      //
      // This took `order.licenseUri`, which the answer route filled from a single
      // EDITION_LICENSE_URI env var — one string for every claim. A licence for one track
      // would then carry another track's artwork, and unset (the default) mints a licence
      // with no metadata at all.
      //
      // fcempowertours does not do that: on a real purchase it reads the master's own
      // tokenURI and passes that. So does this now. The Edition row deliberately stores no
      // uri — its own schema comment says the chain stays authoritative — and the master is
      // the only thing that knows what this licence depicts.
      //
      // A read failure is not fatal: the purchase still succeeds and the licence simply
      // carries no uri, which is what would have happened with the env var unset. Better to
      // sell a licence with no artwork than to fail a claim the hunter already paid for.
      let licenseUri = order.licenseUri;
      try {
        const fromChain = (await pub.readContract({
          address: order.collection,
          abi: LICENSE_ABI,
          functionName: "tokenURI",
          args: [order.masterId],
        })) as string;
        if (fromChain) licenseUri = fromChain;
      } catch {
        // Falls through to whatever the caller passed.
      }

      const hash = await wallet.writeContract({
        address: cfg.salesController,
        abi: SALES_ABI,
        functionName: "purchase",
        args: [order.masterId, order.isCollector, licenseUri],
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
