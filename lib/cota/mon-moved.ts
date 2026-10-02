// ---------------------------------------------------------------------------
// MON moved per wallet, over a window.
//
// Built for the contest that runs during TOKEN2049 week and scores "most MON
// moved", so the one thing it must not do is flatter us. Three sources feed it
// and they do not share a unit:
//
//   spot sold   — KuruSwap.valueWei, the MON the wallet sent. Exact wei.
//   spot bought — KuruSwap.nativeInWei, the MON that reached it. Exact wei,
//                 and NULLABLE, because until October nothing decoded it.
//   perp        — CotaFill.sizeUnits on the MON market, in whole MON as the
//                 venue reports them. A float, and not convertible to exact
//                 wei: 576 MON is 5.76e20 wei, far past where a double counts
//                 integers, so multiplying it up would invent digits.
//
// Hence the shape below. The two spot figures stay exact bigint wei and are
// reported separately; only the combined ranking number is a float, and it is
// labelled as a display figure rather than passed off as a measurement.
//
// A NULL spot buy is COUNTED, NOT ADDED. Treating it as zero would quietly turn
// "we never decoded this" into "they moved nothing", and the resulting total
// would be wrong in the direction that favours whoever has the fewest gaps.
// `unresolvedBuys` is how a reader knows a total is a floor rather than a
// figure, and `complete` is how they know when it is neither.
//
// Pure. No clock — the window is an argument, so a test can pin it — and no
// database. The route fetches; this decides.
// ---------------------------------------------------------------------------

import { MON_MARKET } from "./order";

const WEI_PER_MON = 10n ** 18n;

/** One recorded Kuru spot trade, as the row stores it. */
export interface SpotRow {
  wallet: string;
  ok: boolean;
  /** MON sent with the call — non-zero on a sell, zero on a buy. Decimal wei. */
  valueWei: string;
  /** MON that reached the wallet. Decimal wei, or null for "never established". */
  nativeInWei: string | null;
  at: Date;
}

/** One recorded Perpl fill. */
export interface PerpRow {
  /**
   * The Perpl account. Matched to `SpotRow.wallet` as a lowercased string,
   * which holds because they are the same address — verified against
   * production, where both sources carry 0xe2ab4658…. If a venue ever reports
   * an account that is not the wallet, this splits one hunter across two rows
   * rather than mixing two hunters into one, which is the safer failure.
   */
  account: string;
  marketId: number;
  /** Absolute size in market units. For MON, whole MON. */
  sizeUnits: number;
  filledAt: Date;
}

export interface Window {
  /** Inclusive. */
  from: Date;
  /** EXCLUSIVE, so two adjacent windows cannot both claim the same trade. */
  to: Date;
}

export interface Standing {
  wallet: string;
  /** MON sent on spot sells, exact wei. */
  spotSoldWei: bigint;
  /** MON received on spot buys, exact wei. Excludes undecoded rows. */
  spotBoughtWei: bigint;
  /** MON traded on the MON perp, in whole MON as the venue reports it. */
  perpUnits: number;
  /**
   * The ranking figure, in MON. A float by necessity — see the header — so it
   * is for ordering and display. Anything that has to reconcile reads the wei.
   */
  totalMon: number;
  /** Spot buys whose MON amount was never established. */
  unresolvedBuys: number;
  /** False when any row went uncounted, making `totalMon` a floor. */
  complete: boolean;
}

/**
 * The contest window: 5–11 October 2026, Singapore time.
 *
 * SGT is UTC+8 with no daylight saving, so the offset is a constant and the
 * boundaries below are exact rather than approximate. Written as UTC instants
 * because a Date is an instant and a server's own timezone must not be able to
 * move a boundary: on a box set to UTC this window is the same window as on a
 * box set to Asia/Singapore, which is not true of a date-only comparison.
 *
 * `to` is 12 October 00:00 SGT, not 11 October, because the end is exclusive —
 * the 11th is a scoring day and the whole of it counts.
 */
export const CONTEST_WINDOW: Window = {
  from: new Date("2026-10-04T16:00:00.000Z"), // 2026-10-05 00:00 SGT
  to: new Date("2026-10-11T16:00:00.000Z"), //   2026-10-12 00:00 SGT
};

function inWindow(at: Date, w: Window): boolean {
  const t = at.getTime();
  return t >= w.from.getTime() && t < w.to.getTime();
}

/**
 * Rank wallets by MON moved inside `window`.
 *
 * Reverted spot trades are dropped. They cost the hunter the full gas limit and
 * are worth keeping in the ledger for exactly that reason, but they moved no
 * MON, and a contest counting them would reward failing expensively.
 *
 * Sorted by `totalMon` descending, then by wallet, so the order is stable
 * rather than dependent on input order when two wallets tie.
 */
export function monMoved(
  spot: SpotRow[],
  perp: PerpRow[],
  window: Window,
): Standing[] {
  const by = new Map<string, Standing>();
  const get = (w: string): Standing => {
    const k = w.toLowerCase();
    let s = by.get(k);
    if (!s) {
      s = {
        wallet: k,
        spotSoldWei: 0n,
        spotBoughtWei: 0n,
        perpUnits: 0,
        totalMon: 0,
        unresolvedBuys: 0,
        complete: true,
      };
      by.set(k, s);
    }
    return s;
  };

  for (const r of spot) {
    if (!r.ok) continue;
    if (!inWindow(r.at, window)) continue;
    const s = get(r.wallet);
    s.spotSoldWei += BigInt(r.valueWei);
    if (r.nativeInWei === null) {
      // Known to exist, amount unknown. Not added, and not silently ignored.
      s.unresolvedBuys += 1;
      s.complete = false;
    } else {
      s.spotBoughtWei += BigInt(r.nativeInWei);
    }
  }

  for (const r of perp) {
    if (r.marketId !== MON_MARKET.id) continue;
    if (!inWindow(r.filledAt, window)) continue;
    // Absolute already, but a negative here would subtract from a total it has
    // no business reducing, so it is read as a magnitude.
    get(r.account).perpUnits += Math.abs(r.sizeUnits);
  }

  for (const s of by.values()) {
    // Divided at the very end, once, so the two wei figures stay exact for as
    // long as they can and only the display total loses anything.
    s.totalMon =
      Number(s.spotSoldWei + s.spotBoughtWei) / Number(WEI_PER_MON) +
      s.perpUnits;
  }

  return [...by.values()].sort(
    (a, b) => b.totalMon - a.totalMon || a.wallet.localeCompare(b.wallet),
  );
}

/**
 * Wei → MON, for display.
 *
 * Divides as a bigint first so the whole MON survives exactly however large it
 * is, and only the sub-MON remainder goes through a float. `Number(wei) / 1e18`
 * would be one operation shorter and would start losing whole MON above about
 * 9,007,199 — a figure a contest week could plausibly reach.
 */
export function weiToMon(wei: string | bigint): number {
  const w = typeof wei === "bigint" ? wei : BigInt(wei);
  const neg = w < 0n;
  const abs = neg ? -w : w;
  const mon = Number(abs / WEI_PER_MON) + Number(abs % WEI_PER_MON) / 1e18;
  return neg ? -mon : mon;
}

/** MON, to a fixed number of places, for a screen. */
export function formatMon(mon: number, places = 4): string {
  return mon.toLocaleString("en-US", {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
}
