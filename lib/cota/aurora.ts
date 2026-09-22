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

// ---------------------------------------------------------------------------
// PERSISTENT DEPOSIT ADDRESSES
//
// The quote flow above is a different product from this one, and the difference
// decides what a funding screen can be.
//
// `POST /api/quote` prices a specific movement: it wants an amount, a slippage
// tolerance, a deadline and a refundTo, and it hands back an address good for
// that one swap. A hunter would have to say how much they were about to send
// before they sent it, and the address would go stale.
//
// A persistent deposit address takes none of that. No amount, no deadline, no
// refundTo — it is a mailbox. Aurora's docs are explicit that it has no TTL, and
// the API confirms the rest: creation is IDEMPOTENT on `sender`. Posting the
// same request twice returns the same address with `alreadyExists: true`, and
// changing only `sender` mints a different one. Measured against the live API
// 2026-09-22, not inferred from the docs, which do not state it.
//
// So: one row per hunter per deposit chain, written once, read forever.
// ---------------------------------------------------------------------------

/**
 * The chains Aurora will accept as a deposit origin.
 *
 * Pinned from the API's OWN rejection message rather than from the docs page,
 * because that is the list the server actually validates against — a 400 on an
 * unlisted value enumerates every accepted one. Note `sol`, not `solana`: the
 * obvious spelling is a 400.
 *
 * `evm` is the one that matters here. It is not a chain; it is a shortcut that
 * yields ONE address accepting funds from every EVM chain in this list, which
 * is the "no separate deposit flow to build per chain" the bounty describes.
 */
export const DEPOSIT_CHAINS = [
  "eth", "bera", "base", "gnosis", "arb", "bsc", "avax", "op", "pol", "monad",
  "adi", "plasma", "scroll", "xlayer", "sui", "aptos", "xrp", "btc", "doge",
  "tron", "ton", "near", "sol", "zec", "ltc", "cardano", "stellar", "aleo",
  "bch", "dash", "starknet", "coca", "evm",
] as const;

export type DepositChain = (typeof DEPOSIT_CHAINS)[number];

export function isDepositChain(value: string): value is DepositChain {
  return (DEPOSIT_CHAINS as readonly string[]).includes(value);
}

export interface PersistentAddressRequest {
  /** Where the USDC lands. The hunter's Monad address. */
  recipient: string;
  /**
   * Aurora's attribution key, and the thing creation is idempotent on.
   *
   * It is OUR identifier for the hunter, not an address they hold. Two hunters
   * sharing a `sender` would share a deposit address and therefore each other's
   * incoming money, so this must be something unique per player and stable
   * forever — the player id, never a wallet that can be rotated.
   */
  sender: string;
  depositChain: DepositChain;
}

export interface PersistentAddress {
  depositAddress: string;
  /** False the first time, true on every repeat. Useful only as a signal. */
  alreadyExists: boolean;
}

export async function requestPersistentDepositAddress(
  req: PersistentAddressRequest,
  deps: AuroraDeps = {},
): Promise<PersistentAddress> {
  const key = appKeyOrThrow(deps);
  const doFetch = deps.fetch ?? fetch;
  const res = await doFetch(`${API}/api/persistent-deposit-address/${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      recipient: req.recipient,
      sender: req.sender,
      depositChain: req.depositChain,
      destinationChain: "monad",
      destinationAsset: MONAD_USDC_ASSET_ID,
    }),
    signal: deps.signal,
    cache: "no-store",
  });
  if (!res.ok) {
    throw new AuroraError(`aurora: persistent-deposit-address ${res.status}`);
  }
  return parsePersistentAddress(await res.json());
}

export function parsePersistentAddress(body: unknown): PersistentAddress {
  const b = body as { depositAddress?: unknown; alreadyExists?: unknown };
  if (typeof b.depositAddress !== "string" || b.depositAddress.length === 0) {
    throw new AuroraError("aurora: no depositAddress in response");
  }
  return {
    depositAddress: b.depositAddress,
    alreadyExists: b.alreadyExists === true,
  };
}

/**
 * The three buckets a deposit can be in. There is no richer enum on this path —
 * `received`, `success` and `failed` are query filters, not a status field, and
 * asking for anything else is a 400.
 */
export const DEPOSIT_TYPES = ["received", "success", "failed"] as const;
export type DepositType = (typeof DEPOSIT_TYPES)[number];

export async function readPersistentDeposits(
  depositAddress: string,
  type: DepositType,
  deps: AuroraDeps = {},
): Promise<DepositRecord[]> {
  const key = appKeyOrThrow(deps);
  const doFetch = deps.fetch ?? fetch;
  const url =
    `${API}/api/persistent-deposit-status/${key}` +
    `?address=${encodeURIComponent(depositAddress)}&type=${type}`;
  const res = await doFetch(url, { signal: deps.signal, cache: "no-store" });
  if (!res.ok) {
    throw new AuroraError(`aurora: persistent-deposit-status ${res.status}`);
  }
  return parsePersistentDeposits(await res.json(), type);
}

/**
 * UNVERIFIED ROW SHAPE, and it is spelled out here rather than discovered later.
 *
 * `{"deposits":[]}` is the only response this code has ever seen from the live
 * API, because no money has moved through an address we own. The field names
 * below are the ones the transactions endpoint uses, which is a guess about a
 * sibling endpoint, not knowledge.
 *
 * So this parser is TOTAL: anything it cannot read becomes a dropped row rather
 * than a thrown error or an invented amount. A funding screen that shows one
 * fewer row than it should is a bug; one that shows a number nobody sent is a
 * lie about somebody's money. The first real deposit is what settles this, and
 * until then the caller must treat an empty list as "nothing readable yet"
 * rather than "nothing arrived".
 */
export function parsePersistentDeposits(
  body: unknown,
  type: DepositType,
): DepositRecord[] {
  const rows = (body as { deposits?: unknown })?.deposits;
  if (!Array.isArray(rows)) return [];
  const out: DepositRecord[] = [];
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const depositAddress =
      typeof r.depositAddress === "string"
        ? r.depositAddress
        : typeof r.address === "string"
          ? r.address
          : null;
    if (depositAddress === null) continue;
    out.push({
      // The bucket we asked for IS the status. There is no status field to read
      // and disagree with.
      status: type === "success" ? "SUCCESS" : type === "failed" ? "FAILED" : "PENDING_DEPOSIT",
      depositAddress,
      originAsset: typeof r.originAsset === "string" ? r.originAsset : "",
      destinationAsset:
        typeof r.destinationAsset === "string" ? r.destinationAsset : "",
      amountInFormatted:
        typeof r.amountInFormatted === "string" ? r.amountInFormatted : null,
      amountOutFormatted:
        typeof r.amountOutFormatted === "string" ? r.amountOutFormatted : null,
      createdAt: typeof r.createdAt === "string" ? r.createdAt : null,
    });
  }
  return out;
}
