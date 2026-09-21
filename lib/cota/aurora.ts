// ---------------------------------------------------------------------------
// Aurora Intents — any asset on any of 31+ chains into USDC on Monad, through
// one persistent deposit address per hunter.
//
// WHY THIS EXISTS. The README's own "what does not work yet" section leads with
// it: a hunter who holds value anywhere other than Monad has no way in. The
// Wormhole bridge at /cota/bridge only moves AUSD they ALREADY hold, and only
// from seven chains, and only with a wallet connected on the source chain. A
// person holding SOL, or BTC, or USDC on Base, or a balance sitting on an
// exchange, cannot use it at all.
//
// An Intents deposit address is the opposite shape: we hand the hunter an
// address, they send whatever they have from wherever it is — a wallet, an
// exchange withdrawal, a non-EVM chain — and USDC arrives on Monad. There is no
// per-chain flow to build and nothing for them to connect.
//
// THE CONSTRAINT THAT DECIDES EVERYTHING HERE: Aurora does not carry AUSD.
//
// Verified 2026-09-21 against the public NEAR Intents token list and Aurora's
// own Studio token picker — neither lists AUSD on any chain. Monad itself is
// fully supported, source and destination, but it carries exactly three assets:
// MON, USDC and USDT0.
//
// So this module lands USDC and stops. The rest of the journey to Perpl
// collateral is the leg lib/cota/kuru.ts already runs — USDC -> AUSD through
// Uniswap v4, measured 2026-09-21 at 1.00138 on 10 USDC and 1.00003 on 100.
// That is not a workaround: the USDC Aurora delivers is byte-for-byte the
// `USDC` constant in kuru.ts, so the two halves compose exactly.
//
//   any asset, 31+ chains  ->  USDC on Monad   <- this file
//   USDC -> AUSD                               <- lib/cota/kuru.ts, shipped
//   createAccount(10 AUSD)                     <- lib/cota/deposit.ts, shipped
//
// SERVER ONLY: reads AURORA_INTENTS_APP_KEY. Aurora states the key is not
// confidential and is safe in a public bundle, but it is a spend-shaped
// identifier — our integrator fee settles against it — so it stays server side
// and out of the client bundle like every other credential in this repo.
// ---------------------------------------------------------------------------

/** Aurora's Intents API. The key is a PATH SEGMENT on every route, not a header. */
const API =
  process.env.AURORA_INTENTS_API_URL ?? "https://intents-api.aurora.dev";

/**
 * Monad's assets as NEAR Intents identifies them.
 *
 * `nep245:v2_1.omni.hot.tg:143_…` — 143 is Monad's chain id, and the suffix is
 * the bridge's own handle for the asset, NOT its EVM address. Read from the
 * live token list 2026-09-21; there is no way to derive one from the other, so
 * these are pinned and asserted rather than constructed.
 */
export const MONAD_USDC_ASSET_ID =
  "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx" as const;
export const MONAD_MON_ASSET_ID =
  "nep245:v2_1.omni.hot.tg:143_11111111111111111111" as const;

/**
 * The EVM address the USDC asset id above resolves to on Monad.
 *
 * This is the assertion that keeps the two halves of the on-ramp honest: it
 * must equal `USDC` in lib/cota/kuru.ts, because the whole design rests on
 * Aurora delivering the exact token the USDC->AUSD leg already trades. If
 * Aurora ever repoints that asset id, the equality test in aurora.test.ts
 * fails and this stops being a two-line change nobody noticed.
 */
export const MONAD_USDC_ADDRESS =
  "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as const;

/** USDC and USDT0 are 6dp on Monad; MON is 18. */
export const USDC_DECIMALS = 6;

export class AuroraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuroraError";
  }
}

/**
 * Every status Aurora documents, plus one we add.
 *
 * `UNKNOWN` is not Aurora's — it is what an unrecognised status string becomes.
 * Throwing on one would take down a hunter's funding screen the day Aurora adds
 * a state; silently treating it as in-flight would be fine until the day the
 * new state means "credited" and we under-report. So it parses, it is never
 * credited, and it is never terminal — the screen keeps polling and says it
 * does not know, which is true.
 */
export type DepositStatus =
  | "PENDING_DEPOSIT"
  | "KNOWN_DEPOSIT_TX"
  | "PROCESSING"
  | "SUCCESS"
  | "INCOMPLETE_DEPOSIT"
  | "REFUNDED"
  | "FAILED"
  | "UNKNOWN";

const DOCUMENTED_STATUSES: readonly string[] = [
  "PENDING_DEPOSIT",
  "KNOWN_DEPOSIT_TX",
  "PROCESSING",
  "SUCCESS",
  "INCOMPLETE_DEPOSIT",
  "REFUNDED",
  "FAILED",
];

/**
 * Money arrived and is spendable. SUCCESS and nothing else.
 *
 * Reject by default (AGENTS.md rule 2): this is the predicate a funding screen
 * uses to decide whether to offer the next step, so every state that is not
 * explicitly "credited" must answer false — including UNKNOWN, INCOMPLETE_DEPOSIT
 * (funds landed but under the quote) and REFUNDED (they went back).
 */
export function isCredited(status: DepositStatus): boolean {
  return status === "SUCCESS";
}

/** Nothing further will happen without the hunter sending more funds. */
export function isTerminal(status: DepositStatus): boolean {
  return status === "SUCCESS" || status === "REFUNDED" || status === "FAILED";
}

export function parseStatus(raw: unknown): DepositStatus {
  return typeof raw === "string" && DOCUMENTED_STATUSES.includes(raw)
    ? (raw as DepositStatus)
    : "UNKNOWN";
}

/** What a hunter is shown: where to send, and what they will get. */
export interface DepositQuote {
  /** The address to send to. Persistent and reusable — no TTL. */
  depositAddress: string;
  /** Echoed back by Aurora. Asserted against what we asked for. */
  originAsset: string;
  destinationAsset: string;
  /** The Monad address the USDC is delivered to — the hunter's own wallet. */
  recipient: string;
}

interface QuoteRequest {
  /** The asset the hunter is sending, as an Intents asset id. */
  originAsset: string;
  /** Where the USDC lands. The hunter's own Mera-derived wallet, never ours. */
  recipient: `0x${string}`;
  /**
   * Where funds go if the flow cannot complete. On the ORIGIN chain, so it must
   * be an address the hunter controls there — not their Monad address, unless
   * the origin chain happens to be EVM and the same key signs it.
   *
   * Required. There is no sensible default: guessing it means guessing where
   * someone else's money goes on a failure, and a refund sent to an address
   * nobody holds is indistinguishable from a theft.
   */
  refundTo: string;
  /** Smallest units of originAsset. */
  amount: bigint;
  /** Basis points. */
  slippageTolerance: number;
  deadline: Date;
}

/** Injectable for tests; defaults to the real API. */
export interface AuroraDeps {
  fetch?: typeof fetch;
  appKey?: string;
  signal?: AbortSignal;
}

function appKeyOrThrow(deps: AuroraDeps): string {
  const key = deps.appKey ?? process.env.AURORA_INTENTS_APP_KEY;
  if (!key) throw new AuroraError("AURORA_INTENTS_APP_KEY is not set");
  return key;
}

/**
 * Ask Aurora for a deposit address that lands USDC on Monad.
 *
 * `destinationAsset` is pinned here rather than taken from the caller. A
 * funding screen has exactly one destination — the collateral leg downstream
 * can only consume Monad USDC — and making it a parameter would let a future
 * caller quietly point a hunter's money somewhere the rest of the pipeline
 * cannot spend it.
 */
export async function requestUsdcDepositAddress(
  req: QuoteRequest,
  deps: AuroraDeps = {},
): Promise<DepositQuote> {
  const key = appKeyOrThrow(deps);
  const doFetch = deps.fetch ?? fetch;
  const res = await doFetch(`${API}/api/quote/${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: req.slippageTolerance,
      originAsset: req.originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: MONAD_USDC_ASSET_ID,
      amount: req.amount.toString(),
      recipient: req.recipient,
      recipientType: "DESTINATION_CHAIN",
      refundTo: req.refundTo,
      refundType: "ORIGIN_CHAIN",
      deadline: req.deadline.toISOString(),
    }),
    signal: deps.signal,
    cache: "no-store",
  });
  if (!res.ok) {
    throw new AuroraError(`aurora: quote ${res.status}`);
  }
  return parseDepositQuote(await res.json(), {
    originAsset: req.originAsset,
    recipient: req.recipient,
  });
}

/**
 * Pulled out of the fetch so the parse is testable without a network, and so a
 * malformed response fails HERE with a readable message rather than as an
 * `undefined` reaching a QR code three frames later.
 *
 * The `expected` argument is the point of this function. Kuru taught the
 * lesson (lib/cota/kuru.ts: the route is not promised to us) and it applies
 * harder to an address someone is about to send money to: we do not assume the
 * response describes what we asked for, we check. A quote that comes back
 * pointing at a different destination asset, or paying out to somebody else's
 * recipient, is refused rather than rendered.
 */
export function parseDepositQuote(
  body: unknown,
  expected: { originAsset: string; recipient: string },
): DepositQuote {
  const b = body as {
    depositAddress?: unknown;
    originAsset?: unknown;
    destinationAsset?: unknown;
    recipient?: unknown;
  };
  if (typeof b.depositAddress !== "string" || b.depositAddress.length === 0) {
    throw new AuroraError("aurora: quote response had no depositAddress");
  }
  if (b.destinationAsset !== MONAD_USDC_ASSET_ID) {
    throw new AuroraError(
      `aurora: quote destination is ${String(b.destinationAsset)}, expected Monad USDC`,
    );
  }
  if (b.originAsset !== expected.originAsset) {
    throw new AuroraError(
      `aurora: quote origin is ${String(b.originAsset)}, expected ${expected.originAsset}`,
    );
  }
  // Case-insensitive: Aurora echoes EVM addresses in whatever case it likes,
  // and a checksum difference is not a different recipient.
  if (
    typeof b.recipient !== "string" ||
    b.recipient.toLowerCase() !== expected.recipient.toLowerCase()
  ) {
    throw new AuroraError(
      `aurora: quote recipient is ${String(b.recipient)}, expected ${expected.recipient}`,
    );
  }
  return {
    depositAddress: b.depositAddress,
    originAsset: b.originAsset,
    destinationAsset: b.destinationAsset,
    recipient: b.recipient,
  };
}

/** One movement through a deposit address. */
export interface DepositRecord {
  status: DepositStatus;
  depositAddress: string;
  originAsset: string;
  destinationAsset: string;
  /** Human units, as Aurora formats them. Display only — never arithmetic. */
  amountInFormatted: string | null;
  amountOutFormatted: string | null;
  createdAt: string | null;
}

export async function readDeposits(
  walletAddress: string,
  deps: AuroraDeps = {},
): Promise<DepositRecord[]> {
  const key = appKeyOrThrow(deps);
  const doFetch = deps.fetch ?? fetch;
  const res = await doFetch(
    `${API}/api/transactions/${key}?walletAddress=${encodeURIComponent(walletAddress)}`,
    { signal: deps.signal, cache: "no-store" },
  );
  if (!res.ok) throw new AuroraError(`aurora: transactions ${res.status}`);
  return parseDeposits(await res.json());
}

/**
 * Rows we cannot read are DROPPED, not guessed at.
 *
 * A malformed row in a history list is not worth failing a whole screen over,
 * but inventing a status for it would be — every consumer of this list decides
 * whether someone has money, so a row that cannot be understood must not become
 * a row that says anything.
 */
export function parseDeposits(body: unknown): DepositRecord[] {
  const rows = (body as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return [];
  const out: DepositRecord[] = [];
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    if (
      typeof r.depositAddress !== "string" ||
      typeof r.originAsset !== "string" ||
      typeof r.destinationAsset !== "string"
    ) {
      continue;
    }
    out.push({
      status: parseStatus(r.status),
      depositAddress: r.depositAddress,
      originAsset: r.originAsset,
      destinationAsset: r.destinationAsset,
      amountInFormatted:
        typeof r.amountInFormatted === "string" ? r.amountInFormatted : null,
      amountOutFormatted:
        typeof r.amountOutFormatted === "string" ? r.amountOutFormatted : null,
      createdAt: typeof r.createdAt === "string" ? r.createdAt : null,
    });
  }
  return out;
}
