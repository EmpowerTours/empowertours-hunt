// ---------------------------------------------------------------------------
// What the chain says a Kuru trade did.
//
// Every spot trade until now lived in React state: a hash on screen until the
// hunter reloaded, and then nothing. There was no answer to "what did I trade
// last week", and — worse — no answer to "did that one actually go through the
// order book", which is the claim the screen makes out loud.
//
// The client is not trusted for any of it. It posts a hash and nothing else;
// everything below is read back off the chain. A hunter cannot write a trade
// they did not make, cannot mark a reverted trade successful, and cannot claim
// the order book on a trade that went to a pool. The only thing the client
// contributes is which hash to go and look at.
//
// Pure functions, no network. The route fetches; this decides.
// ---------------------------------------------------------------------------

import { KURU_MON_USDC_MARKET } from "./kuru";

/** Kuru's Flow entrypoint — the `to` of every quote the aggregator returns. */
export const KURU_ENTRYPOINT =
  "0xb3e6778480b2e488385e8205ea05e20060b813cb" as const;

/** keccak("Transfer(address,address,uint256)") */
const TRANSFER =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * The Flow entrypoint's own swap event.
 *
 * NOT recovered from a signature database and NOT guessed — neither
 * openchain.xyz nor a brute force over plausible `Swap(...)` signatures matches
 * this selector, so the layout below is empirical and the hashes that
 * established it are named so the next reader can re-check rather than trust:
 *
 *   0x1453ee16…6fef  sell, crossed the book   8 MON in  -> 198992 USDC out
 *   0x95f14269…2bb0  sell, routed to a pool   5 MON in  -> 123884 USDC out
 *   0x2243ee16…b061  buy                100000000 USDC in -> 2938.5836… MON out
 *
 * topic1 is the user. The seven data words are, in order: tokenIn, tokenOut,
 * a flag, amountIn, amountOut, and two words that are zero in every sample.
 * On the two sells `amountOut` equals the USDC the wallet received to the unit,
 * which `tokensReceived` derives independently from Transfer logs; on the buy it
 * equals the native MON a callTracer trace shows arriving at the wallet, to the
 * wei. Two directions, two independent cross-checks.
 *
 * The flag word is 1 on both sells and 0 on all 25 buys sampled, so it is
 * probably "input is native" — probably, so nothing here reads it.
 */
export const KURU_SWAP_EVENT =
  "0xc2e9a469a567800a865e66b33df0528af708b4d0764eb83443b96980e99f4c68" as const;

/** The 32-byte word at `i` in a log's data, as a bigint. */
function word(data: string, i: number): bigint {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  const at = hex.slice(i * 64, (i + 1) * 64);
  if (at.length < 64) throw new NotAKuruTrade("swap event data is truncated");
  return BigInt("0x" + at);
}

export interface MinimalLog {
  address: string;
  topics: string[];
  data: string;
}

/** The subset of a callTracer frame this module reads. */
export interface TraceFrame {
  to?: string | null;
  value?: string;
  error?: string;
  calls?: TraceFrame[];
}

export interface MinimalReceipt {
  status: "success" | "reverted" | string;
  from: string;
  to: string | null;
  blockNumber: bigint;
  /** On Monad this equals gasLimit — the chain charges the whole limit. */
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  logs: MinimalLog[];
}

export interface TradeRecord {
  hash: string;
  wallet: string;
  ok: boolean;
  blockNumber: bigint;
  /** What the trade actually cost in gas, in wei. See gasChargedWei. */
  gasWei: bigint;
  /** MON sent with the call. Non-zero on a sell, zero on a buy. */
  valueWei: bigint;
  /** ERC-20 units that reached the wallet, keyed by lowercased token. */
  tokensIn: Record<string, bigint>;
  /** ERC-20 units that left the wallet — what a buy actually cost. */
  tokensOut: Record<string, bigint>;
  /** True only when Kuru's MON/USDC market is in the transaction's own logs. */
  crossedOrderBook: boolean;
  /**
   * Native MON that reached the wallet, in wei — the output side of a buy.
   *
   * `null` means UNKNOWN, not zero: no swap event this decoder could read, so
   * the amount has to come from a trace or stay unreported. Zero means known
   * zero, which is the ordinary case for a sell. A leaderboard must be able to
   * tell those apart, so they are not the same value.
   */
  nativeInWei: bigint | null;
}

export class NotAKuruTrade extends Error {}

/**
 * Gas actually charged.
 *
 * Monad charges the WHOLE limit and refunds nothing, so `gasUsed` in a receipt
 * comes back equal to `gasLimit` and this product is the real cost rather than
 * an upper bound on it. That makes it worth storing: it is the one number a
 * hunter cannot recover later from the amounts alone, and on small trades it
 * is most of what they paid.
 */
export function gasChargedWei(
  r: Pick<MinimalReceipt, "gasUsed" | "effectiveGasPrice">,
): bigint {
  return r.gasUsed * r.effectiveGasPrice;
}

/**
 * Did this transaction cross Kuru's MON/USDC order book?
 *
 * Read from the LOGS, not from the calldata. `usesOrderBook` in kuru.ts answers
 * the question before signing, off the bytes we are about to send — the right
 * source when deciding whether to sign. Afterwards the logs are better: they
 * say where the fill happened rather than where the router intended it to. A
 * route can be quoted through the book and land elsewhere.
 *
 * Matches the market as a log emitter OR inside a topic, because Kuru's own
 * market contract emits some events and is named as a party in others.
 */
export function crossedOrderBook(logs: MinimalLog[]): boolean {
  const market = KURU_MON_USDC_MARKET.slice(2).toLowerCase();
  return logs.some(
    (l) =>
      l.address.toLowerCase().includes(market) ||
      l.topics.some((t) => t.toLowerCase().includes(market)),
  );
}

/**
 * ERC-20 units that arrived at `wallet` in this transaction.
 *
 * Summed rather than taken from the last Transfer: a route can pay out in more
 * than one hop, and reading only the final log under-reports it.
 *
 * NOTE what this cannot see. Native MON arriving — a buy — moves no Transfer
 * event, so a buy records an empty map and the received amount stays unknown
 * here. Reconstructing it needs a balance diff around the block, which is a
 * different (and much heavier) call than reading a receipt. Recording zero and
 * calling it "you received 0" would be a lie, so a buy's output is left null
 * and the screen says the gas cost instead.
 */
export function tokensReceived(
  logs: MinimalLog[],
  wallet: string,
): Record<string, bigint> {
  const who = wallet.toLowerCase().slice(2).padStart(64, "0");
  const out: Record<string, bigint> = {};
  for (const l of logs) {
    if (l.topics.length < 3) continue;
    if (l.topics[0].toLowerCase() !== TRANSFER) continue;
    if (l.topics[2].toLowerCase().slice(2) !== who) continue;
    const token = l.address.toLowerCase();
    out[token] = (out[token] ?? 0n) + BigInt(l.data === "0x" ? "0x0" : l.data);
  }
  return out;
}

/**
 * Native MON this transaction delivered to `wallet`, in wei.
 *
 * This is the number a buy had no way of recording. `tokensReceived` reads
 * Transfer logs, and native MON moves no Transfer, so until now a buy stored an
 * empty map and the amount a hunter actually got was simply absent — fine while
 * the screen only showed gas, useless the moment anything has to total MON
 * moved.
 *
 * Read from the entrypoint's own swap event rather than from the order book's.
 * The book event exists and carries a size, but it is per-fill and only present
 * when the route crossed the book: decoding it would report nothing at all on a
 * pool-routed buy, which is most of them. The entrypoint event is emitted once
 * per swap whichever venue filled it — 865 of 865 successful entrypoint
 * transactions in the week to 2 October carry it, none missing — so one decoder
 * covers both routes.
 *
 * TOPIC1 IS THE RECIPIENT, NOT THE SENDER, and the two are not always the same
 * address. On 0x23f3d831…9f11 the sender is 0xc066ac5d… while the event names
 * 0x5458b5ca…, and a trace settles which is which: the whole
 * 29877261360379321582422 wei arrived at the address in the event and nothing at
 * all reached the sender. Matching the event's own field is therefore what makes
 * this "MON this wallet received" rather than "MON some transaction it signed
 * moved".
 *
 * Returns `null` only when the transaction carried NO swap event at all. Where
 * events are present the answer is known even if it is nought: a sell paid out
 * an ERC-20, or the output went to somebody else. Distinguishing the two is the
 * point — a zero stands for "received nothing", and quietly writing it where the
 * truth is "could not tell" is the one outcome that corrupts a total.
 */
export function nativeReceived(
  logs: MinimalLog[],
  wallet: string,
): bigint | null {
  const who = "0x" + wallet.toLowerCase().slice(2).padStart(64, "0");
  let seen = false;
  let total = 0n;
  for (const l of logs) {
    if (l.address.toLowerCase() !== KURU_ENTRYPOINT) continue;
    if (l.topics[0]?.toLowerCase() !== KURU_SWAP_EVENT) continue;
    seen = true;
    // Somebody else's output, bundled into the same transaction. Not this
    // wallet's receipt, so it contributes nothing — but it still counts as
    // evidence the transaction was readable.
    if (l.topics[1]?.toLowerCase() !== who) continue;
    if (word(l.data, 1) === 0n) total += word(l.data, 4);
  }
  return seen ? total : null;
}

/**
 * Native MON delivered to `wallet` by a callTracer trace, in wei.
 *
 * The fallback for a swap that emitted no readable event. `debug_traceTransaction`
 * with the callTracer does work on Monad's public RPC — checked on
 * 0x2243ee16…b061, where it returned 2938583602703400000000, the same wei the
 * swap event reports — but it is a far heavier call than reading a receipt, so
 * nothing calls it unless `nativeReceived` has already come back null.
 *
 * Sums every frame rather than taking the last: a router can pay out over more
 * than one hop. Reverted frames are skipped — their value never moved.
 */
export function nativeReceivedFromTrace(
  frame: TraceFrame,
  wallet: string,
): bigint {
  const who = wallet.toLowerCase();
  let total = 0n;
  const walk = (f: TraceFrame) => {
    if (f.error) return;
    if ((f.to ?? "").toLowerCase() === who && f.value) {
      total += BigInt(f.value);
    }
    for (const c of f.calls ?? []) walk(c);
  };
  walk(frame);
  return total;
}

/**
 * ERC-20 units that LEFT `wallet` in this transaction.
 *
 * The mirror of tokensReceived, and the thing a buy had no record of. A buy
 * sends no MON (`valueWei` is zero) and receives no ERC-20 (`tokensIn` is
 * empty, because MON is native), so the row said what arrived and never what it
 * cost. That is fine for a log and useless for a profit calculation: "did that
 * trade make money" cannot be answered without knowing what the MON sold had
 * been bought for, and the price paid was simply not stored.
 *
 * Summed rather than taken from one log, for the same reason as tokensReceived:
 * a route can pay in more than one hop.
 */
export function tokensSpent(
  logs: MinimalLog[],
  wallet: string,
): Record<string, bigint> {
  const who = wallet.toLowerCase().slice(2).padStart(64, "0");
  const out: Record<string, bigint> = {};
  for (const l of logs) {
    if (l.topics.length < 3) continue;
    if (l.topics[0].toLowerCase() !== TRANSFER) continue;
    // topic1 is `from` — the only difference from tokensReceived, which reads
    // topic2.
    if (l.topics[1].toLowerCase().slice(2) !== who) continue;
    const token = l.address.toLowerCase();
    out[token] = (out[token] ?? 0n) + BigInt(l.data === "0x" ? "0x0" : l.data);
  }
  return out;
}

/**
 * Turn a receipt into the row we store.
 *
 * Refuses anything that is not a Kuru trade by the sender who claims it. Both
 * checks matter and for different reasons: the `to` check stops the log being
 * used as a general-purpose "record any transaction" endpoint, and the `from`
 * check stops one hunter filing somebody else's trade — a stranger's winning
 * trade, or a stranger's reverted one — under their own address.
 *
 * A REVERT IS RECORDED, not dropped. It cost the full gas limit and delivered
 * nothing, which is exactly the event a hunter most needs to find again. A log
 * that shows only successes hides the expensive half.
 */
export function toRecord(
  hash: string,
  wallet: string,
  value: bigint,
  r: MinimalReceipt,
): TradeRecord {
  const w = wallet.toLowerCase();
  if (r.from.toLowerCase() !== w) {
    throw new NotAKuruTrade("that transaction was not sent by this wallet");
  }
  if ((r.to ?? "").toLowerCase() !== KURU_ENTRYPOINT) {
    throw new NotAKuruTrade("that transaction did not go to Kuru");
  }
  return {
    hash: hash.toLowerCase(),
    wallet: w,
    ok: r.status === "success",
    blockNumber: r.blockNumber,
    gasWei: gasChargedWei(r),
    valueWei: value,
    // A reverted transaction emits no logs, so both of these read as "nothing
    // happened" on their own. `ok` is what distinguishes that from a fill.
    tokensIn: r.status === "success" ? tokensReceived(r.logs, w) : {},
    tokensOut: r.status === "success" ? tokensSpent(r.logs, w) : {},
    crossedOrderBook: r.status === "success" && crossedOrderBook(r.logs),
    // A revert delivered nothing, and that is known rather than unknown: zero,
    // not null. It still cost the full gas limit, which is why the row is kept.
    nativeInWei: r.status === "success" ? nativeReceived(r.logs, w) : 0n,
  };
}
