// ---------------------------------------------------------------------------
// What the spot trades actually made, in MON and in dollars.
//
// NOT THE SAME ARITHMETIC AS /cota/history, which folds Perpl fills. A perp
// position opens and closes in one asset and the result is
// (exit - entry) x size - fees, denominated in the collateral; a trip is over
// when the signed sizes net to zero. Spot has no position to close. You hold
// MON, then you hold USDC, then you hold MON again, and the question "did that
// make money" cannot be answered without saying what the MON you just sold had
// cost you. That is a cost basis, and nothing in the Perpl fold has one.
//
// FIFO, matching tablero, so the two never disagree about the same wallet.
//
// BOTH UNITS, because they genuinely differ and the difference is the point. On
// 4 October a round trip sold 1,629.33 MON for $58.50 and bought 1,734.71 MON
// back with the same $58.50: +105.38 MON and exactly $0.00. A screen showing
// only dollars calls that nothing; one showing only MON calls it a win. Both
// are true, and which matters depends on whether the next thing spent is a
// spawn or an invoice.
//
// Pure. No clock, no network, no database.
// ---------------------------------------------------------------------------

/** One recorded Kuru trade, as KuruSwap stores it. */
export interface SpotTrade {
  hash: string;
  /** "buy" acquires MON, "sell" disposes of it. */
  side: string;
  ok: boolean;
  /** MON sent, wei. Non-zero on a sell. */
  valueWei: string;
  /** MON received, wei, or null when it was never established. */
  nativeInWei: string | null;
  /** USDC/AUSD that reached the wallet, keyed by lowercased token, 6dp. */
  tokensIn: Record<string, string>;
  /** USDC/AUSD that LEFT the wallet — what a buy cost. 6dp. */
  tokensOut: Record<string, string>;
  /** Gas charged, wei. On Monad this is the whole limit. */
  gasWei: string;
  at: Date;
}

/** One disposal matched against the acquisitions that paid for it. */
export interface Disposal {
  hash: string;
  at: Date;
  /** MON sold, wei. */
  monWei: bigint;
  /** Dollars received, 6dp. */
  proceeds6: bigint;
  /** Dollars those MON had cost, 6dp, by FIFO. */
  basis6: bigint;
  /** proceeds - basis, 6dp. Negative is a loss. */
  realised6: bigint;
}

export interface SpotResult {
  disposals: Disposal[];
  /** Realised dollars across every matched disposal, 6dp. */
  realised6: bigint;
  /** MON bought minus MON sold, wei. The treasury's own unit. */
  netMonWei: bigint;
  /** Gas across every trade counted, wei. */
  gasWei: bigint;
  /** MON acquired but not yet sold, wei, with what it cost. */
  openMonWei: bigint;
  openBasis6: bigint;
  /**
   * Disposals that could not be priced, because the MON received on an earlier
   * buy was never established. Reported, never guessed at.
   */
  unpriced: number;
}

const WEI = 10n ** 18n;

/**
 * Dollars in a token map, 6dp.
 *
 * USDC and AUSD are both dollar stablecoins at six decimals, so they add
 * directly. Anything else in the map would not, and nothing else reaches these
 * rows — the two legs trade exactly these.
 */
function dollars(map: Record<string, string> | null | undefined): bigint {
  let total = 0n;
  for (const units of Object.values(map ?? {})) total += BigInt(units);
  return total;
}

interface Lot {
  monWei: bigint;
  /** What this lot cost, 6dp. */
  cost6: bigint;
}

/**
 * Fold spot trades into realised results.
 *
 * Reverted trades are dropped: they moved no MON. Their gas is NOT dropped —
 * it was really paid, and a result that hides the cost of failure flatters the
 * strategy that produced it.
 */
export function foldSpot(trades: SpotTrade[]): SpotResult {
  const ordered = [...trades].sort((a, b) => a.at.getTime() - b.at.getTime());

  const lots: Lot[] = [];
  const disposals: Disposal[] = [];
  let realised6 = 0n;
  let netMonWei = 0n;
  let gasWei = 0n;
  let unpriced = 0;

  for (const t of ordered) {
    gasWei += BigInt(t.gasWei);
    if (!t.ok) continue;

    if (t.side === "buy") {
      // MON in, dollars out. Both sides are now on the row: nativeInWei is what
      // arrived, tokensOut is what it cost. A buy whose MON amount was never
      // established cannot open a lot — pricing it would mean inventing either
      // the size or the basis — so it is counted and reported instead.
      const got = t.nativeInWei === null ? null : BigInt(t.nativeInWei);
      if (got === null || got <= 0n) {
        unpriced += 1;
        continue;
      }
      netMonWei += got;
      lots.push({ monWei: got, cost6: dollars(t.tokensOut) });
      continue;
    }

    // A sell: MON out, dollars in.
    const sold = BigInt(t.valueWei);
    if (sold <= 0n) continue;
    netMonWei -= sold;
    const got6 = dollars(t.tokensIn);

    let remaining = sold;
    let basis6 = 0n;
    while (remaining > 0n && lots.length > 0) {
      const lot = lots[0];
      const take = lot.monWei <= remaining ? lot.monWei : remaining;
      basis6 += (lot.cost6 * take) / lot.monWei;
      lot.cost6 -= (lot.cost6 * take) / lot.monWei;
      lot.monWei -= take;
      remaining -= take;
      if (lot.monWei === 0n) lots.shift();
    }

    const r6 = got6 - basis6;
    realised6 += r6;
    disposals.push({
      hash: t.hash,
      at: t.at,
      monWei: sold,
      proceeds6: got6,
      basis6,
      realised6: r6,
    });
  }

  let openMonWei = 0n;
  let openBasis6 = 0n;
  for (const l of lots) {
    openMonWei += l.monWei;
    openBasis6 += l.cost6;
  }

  return {
    disposals,
    realised6,
    netMonWei,
    gasWei,
    openMonWei,
    openBasis6,
    unpriced,
  };
}

/** MON from wei, two places, for a screen. */
export function monText(wei: bigint): string {
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const whole = abs / WEI;
  const frac = ((abs % WEI) * 100n) / WEI;
  return `${neg ? "-" : ""}${whole}.${frac.toString().padStart(2, "0")}`;
}

/** Dollars from 6dp, two places. */
export function usdText(a6: bigint): string {
  const neg = a6 < 0n;
  const abs = neg ? -a6 : a6;
  const whole = abs / 1_000_000n;
  const frac = ((abs % 1_000_000n) * 100n) / 1_000_000n;
  return `${neg ? "-" : ""}${whole}.${frac.toString().padStart(2, "0")}`;
}
