// ---------------------------------------------------------------------------
// One button: get a hunter from "I have some MON" to "I have a position".
//
// The Cota hub grew into eleven buttons — swap, bridge, swap USDC, on-ramp,
// deposit, trade, risk, results, leaderboard, spot, enrol — each of which is a
// real step somebody has to do in roughly that order. A hunter who has just
// walked to a cache and collected 1 MON cannot be expected to work out which
// four of the eleven apply to them, and a tester looking at the trade screen
// wrote "no sé que significa nada". Eleven correct buttons are worse than one.
//
// So this decides, from balances alone, exactly what the next press will do —
// and says so BEFORE it is pressed. Nothing here signs, sends, or spends; it
// returns a plan the screen can print as a sentence and the orchestrator can
// execute. A plan that cannot be carried out comes back as a shortfall with the
// exact number of MON still missing, never as a button that fails on tap.
//
// THE $10 FLOOR IS PERPL'S, NOT OURS. Their published context carries
// min_deposit_amount = min_account_open_amount = 10000000 at six decimals, so
// no deposit under ten dollars is accepted at all. At $0.0341 a MON that is
// ~293 MON, against a spawn worth one. This function is therefore mostly in the
// business of telling a hunter honestly how far away they are, which is the one
// job the eleven buttons did not do.
//
// Pure. No clock, no network, no database. Gas is an ARGUMENT, not a constant:
// deriving a reserve by guessing is a mistake this codebase has already made
// once, and on Monad the whole gas limit is charged whether used or not, so the
// caller estimates it and passes it in.
// ---------------------------------------------------------------------------

/** What a single press will actually do, in order. */
export type Step = "swap" | "deposit" | "leash" | "trade";

export interface Balances {
  /** Native MON in the hunter's wallet, in wei. */
  walletMonWei: bigint;
  /** AUSD already in the wallet, at 6 decimals. */
  walletAusd6: bigint;
  /** AUSD already posted at Perpl as collateral, at 6 decimals. */
  perplAusd6: bigint;
}

export interface Conditions {
  /** A trading key is enrolled for this wallet. */
  enrolled: boolean;
  /** A live, unexpired leash governs the market we would trade. */
  hasLeash: boolean;
  /** MON in USD. From the live book, never assumed. */
  monUsd: number;
  /**
   * Perpl's minimum deposit, 6dp. Read from their context rather than written
   * down here: it is their number and they can change it.
   */
  minDeposit6: bigint;
  /** The collateral a trade needs available, 6dp. */
  minTrade6: bigint;
  /**
   * The live leash's notional ceiling, 6dp, or null when none is live yet.
   *
   * The order has to fit UNDER the leash the hunter already signed. Without
   * this the planner would offer a pressable button to someone holding $50
   * against a $20 leash, every step would run, and the last one would bounce
   * off their own ceiling — money moved, no position, and the refusal arriving
   * from the one component whose job is to refuse. When null, the press signs
   * a fresh leash and `oneClickNotional6` is what that leash will permit.
   */
  leashMaxNotional6: bigint | null;
  /**
   * The ceiling a freshly signed one-click leash will carry, 6dp.
   *
   * Used when leashMaxNotional6 is null, so the plan can size an order against
   * the leash it is about to create rather than against one that exists.
   */
  oneClickNotional6: bigint;
  /**
   * The smallest order the venue will actually fill, 6dp.
   *
   * Chain-verified: a $1 MON market order filled 0 and came back
   * TakerOrderSettlementFailed, a $3 one filled fully. An order under this is
   * not a small trade, it is a failed one.
   */
  minFillable6: bigint;
  /**
   * MON held back for gas across every step, in wei.
   *
   * Estimated by the caller against the real calls. A flat reserve is the same
   * bug as a flat gas limit — it is wrong the moment the route or the base fee
   * moves, and on Monad a wrong limit is charged in full anyway.
   */
  gasReserveWei: bigint;
  /** Slippage allowance on the MON->AUSD leg, in basis points. */
  slippageBps: bigint;
}

export interface Plan {
  ok: true;
  steps: Step[];
  /** MON to sell for AUSD. Zero when the wallet already holds enough AUSD. */
  swapMonWei: bigint;
  /** AUSD to post to Perpl. Zero when the account is already funded. */
  depositAusd6: bigint;
  /** Collateral that will back the trade once the steps above have run. */
  tradeAusd6: bigint;
  /**
   * The notional the order will actually be sent at, 6dp.
   *
   * Clamped to whatever leash governs it, so the press cannot end by having its
   * own order refused by the hunter's own ceiling.
   */
  orderNotional6: bigint;
}

export interface Blocked {
  ok: false;
  reason: "not_enrolled" | "short" | "below_min_order";
  /** Extra MON the wallet still needs. Zero for reasons that are not money. */
  shortfallMonWei: bigint;
  /** What the hunter has to work with now, for a progress line. */
  haveMonWei: bigint;
  /** What they need in total. */
  needMonWei: bigint;
}

export type OneClick = Plan | Blocked;

const WEI = 10n ** 18n;
/** AUSD is 6dp, like USDC. */
const AUSD = 1_000_000n;

/**
 * MON needed to end up with `ausd6` after the swap, in wei.
 *
 * Rounds UP and adds the slippage allowance, because this number decides
 * whether the button is offered at all: landing a hair under Perpl's floor
 * after a swap means the deposit reverts and the hunter has paid gas to end up
 * with AUSD they cannot use. Overshooting costs nothing — the remainder stays
 * theirs as AUSD.
 */
export function monForAusd(
  ausd6: bigint,
  monUsd: number,
  slippageBps: bigint,
): bigint {
  if (!(monUsd > 0) || !Number.isFinite(monUsd)) {
    throw new RangeError("monUsd must be a positive finite price");
  }
  // Price as an integer at 6dp so the division stays in bigint. Ceil both the
  // price conversion and the slippage mark-up.
  const priceE6 = BigInt(Math.ceil(monUsd * 1e6));
  if (priceE6 <= 0n) throw new RangeError("monUsd rounds to zero");
  const withSlip = (ausd6 * (10_000n + slippageBps) + 9_999n) / 10_000n;
  // ausd6 / (priceE6 / 1e6) in wei = ausd6 * 1e18 / priceE6, rounded up.
  return (withSlip * WEI + priceE6 - 1n) / priceE6;
}

/**
 * What one press should do.
 *
 * Order is fixed and each step is skipped only when it is already satisfied:
 * swap for AUSD, post it as collateral, sign the leash that bounds the agent,
 * then trade. The leash is never skipped for convenience — it is the thing that
 * makes every later step bounded, and a button that quietly traded without one
 * would be the product contradicting its own claim.
 */
export function planOneClick(b: Balances, c: Conditions): OneClick {
  if (!c.enrolled) {
    return {
      ok: false,
      reason: "not_enrolled",
      shortfallMonWei: 0n,
      haveMonWei: b.walletMonWei,
      needMonWei: 0n,
    };
  }

  const steps: Step[] = [];

  // Already-posted collateral counts first: a hunter who funded last week
  // should not be asked to swap again.
  const haveAtVenue = b.perplAusd6;
  const needAtVenue =
    c.minTrade6 > haveAtVenue ? c.minTrade6 - haveAtVenue : 0n;

  let depositAusd6 = 0n;
  let swapMonWei = 0n;

  if (needAtVenue > 0n) {
    // Perpl refuses anything under its floor, so a $2 shortfall still means a
    // $10 deposit. Topping up by the difference is not an option they offer.
    depositAusd6 = needAtVenue > c.minDeposit6 ? needAtVenue : c.minDeposit6;

    const fromWallet =
      b.walletAusd6 >= depositAusd6 ? depositAusd6 : b.walletAusd6;
    const toBuy = depositAusd6 - fromWallet;

    if (toBuy > 0n) {
      swapMonWei = monForAusd(toBuy, c.monUsd, c.slippageBps);
      steps.push("swap");
    }
    steps.push("deposit");
  }

  // Gas is needed only for the steps that actually touch the chain.
  //
  // THE LEASH IS ONE OF THEM, which is not obvious from its name.
  // signAndAnchorCota signs the EIP-712 message and then anchors the digest on
  // Monad, so a leash costs a transaction like the other two. Leaving it out —
  // as a first version of this did, reasoning that a signature is free — would
  // have let a hunter through with just enough MON for the swap and the
  // deposit, and then produced a leash whose anchor silently failed. The anchor
  // is tolerated as best-effort in sign.ts precisely so a bad moment does not
  // lose the signature, and that tolerance is exactly what would have hidden it.
  //
  // Only placing the order is free: it goes over the enrolled trading key.
  //
  // Charging a reserve when NOTHING touches the chain would strand the hunter
  // who funded Perpl last week and has since spent their MON — holding
  // collateral at the venue, perfectly able to trade it, and told they were
  // short. The same shape as the travel lockout: a requirement that cannot be
  // met and does not need to be.
  //
  // Added to the requirement rather than checked against what is left after the
  // swap, because the swap spends the same balance: needing 296 MON of input
  // and 0.15 of gas means needing 296.15, not 296.
  // Read from willSignLeash, NOT from steps.includes("leash"): the leash is
  // pushed below, after this check, so asking the array here would always say
  // no. That ordering is what made the first attempt at this fix pass its own
  // test while changing nothing.
  const willSignLeash = !c.hasLeash;
  const touchesChain =
    steps.includes("swap") || steps.includes("deposit") || willSignLeash;
  const needMonWei = swapMonWei + (touchesChain ? c.gasReserveWei : 0n);
  if (b.walletMonWei < needMonWei) {
    return {
      ok: false,
      reason: "short",
      shortfallMonWei: needMonWei - b.walletMonWei,
      haveMonWei: b.walletMonWei,
      needMonWei,
    };
  }

  const tradeAusd6 = haveAtVenue + depositAusd6;

  // The order sits under whichever leash will govern it: the live one, or the
  // one this press is about to sign. Clamping rather than refusing, because a
  // hunter with more collateral than their ceiling has not done anything wrong
  // — they just cannot put all of it to work under the limits they set.
  const ceiling = c.leashMaxNotional6 ?? c.oneClickNotional6;
  const orderNotional6 = tradeAusd6 < ceiling ? tradeAusd6 : ceiling;

  // A clamp can land under the venue's fill floor, and an order below it does
  // not fill small — it fails. Better to say so now than after the money has
  // moved through three irreversible steps.
  if (orderNotional6 < c.minFillable6) {
    return {
      ok: false,
      reason: "below_min_order",
      shortfallMonWei: 0n,
      haveMonWei: b.walletMonWei,
      needMonWei: needMonWei,
    };
  }

  if (willSignLeash) steps.push("leash");
  steps.push("trade");

  return {
    ok: true,
    steps,
    swapMonWei,
    depositAusd6,
    tradeAusd6,
    orderNotional6,
  };
}

/** MON, from wei, for a progress line. Two places is enough to walk toward. */
export function monLabel(wei: bigint): string {
  const whole = wei / WEI;
  const frac = ((wei % WEI) * 100n) / WEI;
  return `${whole}.${frac.toString().padStart(2, "0")}`;
}

/** AUSD, from 6dp, as dollars. */
export function ausdLabel(a6: bigint): string {
  const whole = a6 / AUSD;
  const frac = ((a6 % AUSD) * 100n) / AUSD;
  return `${whole}.${frac.toString().padStart(2, "0")}`;
}
