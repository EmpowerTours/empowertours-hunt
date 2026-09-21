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

export interface MinimalLog {
  address: string;
  topics: string[];
  data: string;
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
  /** True only when Kuru's MON/USDC market is in the transaction's own logs. */
  crossedOrderBook: boolean;
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
export function gasChargedWei(r: Pick<MinimalReceipt, "gasUsed" | "effectiveGasPrice">): bigint {
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
    crossedOrderBook: r.status === "success" && crossedOrderBook(r.logs),
  };
}
