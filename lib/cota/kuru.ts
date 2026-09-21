// ---------------------------------------------------------------------------
// MON -> AUSD through Kuru, in two legs, with the trade on Kuru's ORDER BOOK.
//
// This is the on-ramp a new hunter needs: Perpl will not open an account under
// 10 AUSD, and AUSD is the illiquid leg on Monad. Until now the only route was
// our own subsidised swap desk (lib/cota/swap.ts) — a contract we fund, price
// from Chainlink and cap at 15 AUSD a day. Kuru routes the user's own MON
// through the market instead, so there is no float to seed and no cap.
//
// WHY TWO LEGS AND NOT ONE. Asking Kuru for MON->AUSD directly works and was
// proven with a real fill, but it routes through a Uniswap v4 pool and never
// touches Kuru's book — verified by grepping the receipt for the market
// address. Kuru's own MON_AUSD book is ~$5 deep and prices 17% away from the
// market, so it cannot carry a 10 AUSD onboarding at all.
//
// MON->USDC is the opposite: it routes through the order book
// (KURU_MON_USDC_MARKET below appears in the calldata, the v4 manager does
// not), the book is deep, and it charges 0 bps. So:
//
//   leg 1  MON  -> USDC   on Kuru's order book   <- the trade; price discovery
//   leg 2  USDC -> AUSD   stable hop, ~1.00008   <- conversion, not a trade
//
// The cost of splitting it is about 0.8% against the single v4 hop and one
// extra transaction's gas. What it buys is that the price-forming leg really
// does execute on Kuru's book, which is the claim this integration makes.
//
// THE ROUTE IS NOT PROMISED TO US. Kuru's aggregator picks a path per quote and
// may reroute leg 1 away from the book without telling anyone. So we do not
// assume — `usesOrderBook` reads the calldata we are about to sign and reports
// what is actually in it. A caller that needs the book can refuse.
// ---------------------------------------------------------------------------

/** Native MON, as Kuru's API expects it for a native-in swap. */
export const NATIVE = "0x0000000000000000000000000000000000000000" as const;
export const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as const;
export const AUSD = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a" as const;

/**
 * Kuru's MON/USDC order book market. Its presence in a quote's calldata is the
 * only evidence that a swap actually crossed the book rather than an AMM, and
 * it is what the whole two-leg design exists to guarantee.
 */
export const KURU_MON_USDC_MARKET =
  "0x065c9d28e428a0db40191a54d33d5b7c71a9c394" as const;

/**
 * Kuru's swap executor — and the address an ERC-20 leg must be approved to.
 *
 * NOT the entrypoint the quote addresses its transaction to. Approving that one
 * leaves the swap reverting 0x5264a63f with a perfectly good allowance in
 * place; the entrypoint delegates the token pull to this contract. Kuru's
 * documentation does not mention it, and it is only visible by decoding a
 * receipt or by elimination.
 *
 * Same deployer as the entrypoint (0xb624377f…E91E), 17KB, holds nothing at
 * rest — a pass-through router, not a custodian.
 */
export const KURU_EXECUTOR =
  "0x2f84fb8982073f39ba47c7fcc29119af074abbcb" as const;

/** Uniswap v4's PoolManager on Monad. Present in leg 2, absent from leg 1. */
export const UNISWAP_V4_POOL_MANAGER =
  "0x188d586ddcf52439676ca21a244753fa19f9ea8e" as const;

const API = process.env.KURU_API_URL ?? "https://ws.kuru.io";

export interface KuruQuote {
  /** Units out, in the output token's own decimals. */
  output: bigint;
  /** The floor the swap will revert below. Never send a transaction without it. */
  minOut: bigint;
  to: `0x${string}`;
  value: bigint;
  calldata: `0x${string}`;
  /** True when Kuru's MON/USDC order book is in the path we are about to sign. */
  usesOrderBook: boolean;
}

/**
 * A short-lived token for the quote endpoint.
 *
 * Permissionless: it takes a wallet address and no secret, which is why this
 * needs no API key and nothing had to be arranged with Kuru. Rate-limited to
 * 1 request per second per token, so mint one PER USER rather than sharing a
 * process-wide token that every hunter would queue behind.
 */
export async function kuruToken(
  userAddress: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(`${API}/api/generate-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user_address: userAddress }),
    signal,
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`kuru: token ${res.status}`);
  const body = (await res.json()) as { token?: unknown };
  if (typeof body.token !== "string" || body.token.length === 0) {
    throw new Error("kuru: token response had no token");
  }
  return body.token;
}

/**
 * How much the fill may come in under the quote before the swap reverts.
 *
 * NOT `autoSlippage`. Measured on mainnet, autoSlippage leaves 14 bps — and on
 * Monad that is not enough. Execution is asynchronous: `eth_call` runs against
 * speculative state roughly three blocks ahead of where the transaction
 * actually executes, so a simulation cannot see the state the trade lands in.
 * Add the time a hunter spends confirming with a passkey and the book moves
 * past 14 bps routinely. A real 5 MON trade reverted exactly this way with
 * KuruFlowEntrypoint_InsufficientAmountAfterFees (0x5264a63f).
 *
 * Widening is the cheaper mistake. A revert on Monad is charged the WHOLE gas
 * limit with no refund and delivers nothing, so one fill 100 bps worse beats
 * two reverts and a fill. What makes that honest rather than sloppy is showing
 * the floor: the screen must print what the hunter will receive AT LEAST, not
 * only the estimate.
 */
export const DEFAULT_SLIPPAGE_BPS = 100;

/**
 * One leg. Returns the transaction Kuru wants us to send, plus what venue it
 * actually goes through.
 *
 * `autoSlippage` and `slippageTolerance` are mutually exclusive in Kuru's
 * schema — a `oneOf`, so sending both is rejected outright. This sends the
 * explicit one and never the other.
 */
export async function kuruQuote(args: {
  token: string;
  userAddress: string;
  tokenIn: string;
  tokenOut: string;
  /** Smallest units of tokenIn. Native MON is 18dp. */
  amount: bigint;
  /** Basis points of room under the quote. See DEFAULT_SLIPPAGE_BPS. */
  slippageBps?: number;
  signal?: AbortSignal;
}): Promise<KuruQuote> {
  const res = await fetch(`${API}/api/quote`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${args.token}`,
    },
    body: JSON.stringify({
      userAddress: args.userAddress,
      tokenIn: args.tokenIn,
      tokenOut: args.tokenOut,
      amount: args.amount.toString(),
      slippageTolerance: args.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
    }),
    signal: args.signal,
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`kuru: quote ${res.status}`);
  return parseQuote(await res.json());
}

/**
 * Pulled out of the fetch so the parse is testable without a network, and so a
 * malformed response fails here with a readable message rather than as a
 * `undefined` reaching viem three frames later.
 */
export function parseQuote(body: unknown): KuruQuote {
  const b = body as {
    output?: unknown;
    minOut?: unknown;
    transaction?: {
      to?: unknown;
      value?: unknown;
      data?: unknown;
      calldata?: unknown;
    };
  };
  const tx = b.transaction;
  const data = (tx?.data ?? tx?.calldata) as unknown;
  if (
    typeof b.output !== "string" ||
    typeof b.minOut !== "string" ||
    typeof tx?.to !== "string" ||
    typeof data !== "string"
  ) {
    throw new Error("kuru: quote response missing output/minOut/transaction");
  }
  // KURU RETURNS CALLDATA WITHOUT THE 0x PREFIX. `to` has one; `data` does
  // not. Casting the raw string to `0x${string}` type-checks and is a lie —
  // viem then sends different bytes than Kuru built, and the transaction
  // reverts with EMPTY revert data at any gas limit and against any block,
  // which looks like everything except a malformed payload.
  //
  // Cost a real 5 MON trade and a long hunt through gas limits, slippage and
  // asynchronous execution before the calldata was compared byte for byte
  // against a fresh quote: 644 bytes sent against 420 quoted, and a selector of
  // 0x1e703000 against ce1e7030. A prefix, silently.
  const raw = data.toLowerCase();
  const calldata = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
  return {
    output: BigInt(b.output),
    minOut: BigInt(b.minOut),
    to: normaliseAddress(tx.to),
    value: BigInt((tx.value as string | undefined) ?? "0"),
    calldata,
    usesOrderBook: usesOrderBook(calldata),
  };
}

/**
 * Does this calldata route through Kuru's MON/USDC order book?
 *
 * Read from the bytes we are about to sign, not from the venue we hoped for.
 * Kuru's router chooses a path per quote; a change on their side would
 * otherwise turn "our trades execute on Kuru's order book" into a false claim
 * with nothing on our side noticing.
 */
/**
 * `to` arrives prefixed today, but nothing in their schema promises it and the
 * calldata field already proved that assumption wrong once.
 */
function normaliseAddress(a: string): `0x${string}` {
  const low = a.toLowerCase();
  return (low.startsWith("0x") ? low : `0x${low}`) as `0x${string}`;
}

export function usesOrderBook(calldata: string): boolean {
  return calldata
    .toLowerCase()
    .includes(KURU_MON_USDC_MARKET.slice(2).toLowerCase());
}

export interface OnboardingPlan {
  legs: [KuruQuote, KuruQuote];
  /** AUSD the hunter ends up with, in 6dp units. */
  ausdOut: bigint;
  /** True only when leg 1 really crossed Kuru's order book. */
  throughOrderBook: boolean;
}

/**
 * Plan the whole MON -> AUSD on-ramp.
 *
 * Leg 2 is quoted against leg 1's EXPECTED output, which is an estimate: the
 * USDC actually received can be a shade less. So leg 2 must be re-quoted with
 * the real balance once leg 1 has landed — this plan is for showing the hunter
 * a number and deciding whether to proceed, not for signing leg 2 in advance.
 */
export async function planOnboarding(args: {
  userAddress: string;
  monWei: bigint;
  signal?: AbortSignal;
}): Promise<OnboardingPlan> {
  const token = await kuruToken(args.userAddress, args.signal);
  const leg1 = await kuruQuote({
    token,
    userAddress: args.userAddress,
    tokenIn: NATIVE,
    tokenOut: USDC,
    amount: args.monWei,
    signal: args.signal,
  });
  const leg2 = await kuruQuote({
    token,
    userAddress: args.userAddress,
    tokenIn: USDC,
    tokenOut: AUSD,
    amount: leg1.output,
    signal: args.signal,
  });
  return {
    legs: [leg1, leg2],
    ausdOut: leg2.output,
    throughOrderBook: leg1.usesOrderBook,
  };
}
