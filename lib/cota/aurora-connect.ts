import { base58 } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";

// ---------------------------------------------------------------------------
// Intents Connect — deposit and execute.
//
// The difference from lib/cota/aurora.ts, which is Intents DEPOSITS: a deposit
// address delivers an asset and stops. Connect delivers the asset AND runs
// transactions on Monad the moment it lands, from an account the hunter
// controls. One send from another chain, and they arrive already funded, already
// swapped, already holding what the next screen needs.
//
// A DIFFERENT SERVICE FROM THE REST OF AURORA. Different host — intents-connect
// -api, not intents-api — and a different auth scheme: the key goes in an
// `x-api-key` HEADER, where Deposits puts it in the URL path. Bearer, `api-key`
// and a raw Authorization header all 401. The same app key authorises both.
//
// WHY THIS DOES NOT COST US THE NON-CUSTODY CLAIM, which is the only reason it
// is worth integrating at all. Steps execute from an intermediary account that
// is MPC-derived from the hunter's own address: the signed payload carries
// `path` = their EVM address, and Aurora's docs are explicit that they do not
// own it and have no independent authority to move funds. The hunter authorises
// two specific transaction hashes and nothing else.
// ---------------------------------------------------------------------------

const API =
  process.env.AURORA_INTENTS_CONNECT_URL ??
  "https://intents-connect-api.aurora.dev";

export class ConnectError extends Error {
  constructor(
    message: string,
    /** True when Aurora refused because one is already in flight. */
    readonly inFlight = false,
  ) {
    super(message);
  }
}

function appKeyOrThrow(explicit?: string): string {
  const key = explicit ?? process.env.AURORA_INTENTS_APP_KEY;
  if (!key) throw new ConnectError("AURORA_INTENTS_APP_KEY is not set");
  return key;
}

/** One transaction the intermediary account will run once funds land. */
export interface ExecutionStep {
  to: string;
  /** e.g. `deposit()`. At most 1024 bytes; tuples nest at most 6 deep. */
  functionSignature: string;
  parameters: unknown[];
  /** Native value in wei, as a decimal string. */
  value: string;
}

export interface ExecutionQuote {
  originAsset: string;
  destinationAsset: string;
  /** Smallest units of originAsset, decimal string. */
  amount: string;
  slippageTolerance: number;
  swapType: "EXACT_INPUT";
  deadline: string;
}

export interface Execution {
  id: string;
  status: string;
  /** Where the hunter sends funds on the origin chain. */
  depositAddress: string | null;
  /** MPC-derived, controlled by the hunter's key. Steps run from here. */
  intermediaryAddress: string | null;
  /** The NEAR Intents payload to sign. Null on a dry run. */
  messageToSign: string | null;
  messageSigned: boolean;
  /** Wei, decimal string — Aurora's own fee step, priced into the quote. */
  networkFee: string | null;
  /** Seconds, as Aurora estimates it. */
  estimatedTime: string | null;
  /** Smallest units of destinationAsset expected to arrive. */
  amountOut: string | null;
  minAmountOut: string | null;
}

/**
 * Aurora appends its own fee-transfer step to whatever is sent, so the array
 * that executes is longer than the array requested. Worth knowing before
 * counting steps against the 30-step ceiling.
 */
export const MAX_EVM_STEPS = 30;

export function parseExecution(body: unknown): Execution {
  const r = (body as { result?: unknown })?.result ?? body;
  const e = r as {
    id?: unknown;
    status?: unknown;
    quote?: { depositAddress?: unknown; amountOut?: unknown; minAmountOut?: unknown };
    details?: {
      intermediaryAddress?: unknown;
      messageToSign?: unknown;
      messageSigned?: unknown;
      networkFee?: unknown;
      estimatedTime?: unknown;
    };
  };
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  if (typeof e.id !== "string" && typeof e.status !== "string") {
    throw new ConnectError("aurora: unrecognisable execution response");
  }
  return {
    id: typeof e.id === "string" ? e.id : "",
    status: typeof e.status === "string" ? e.status : "UNKNOWN",
    depositAddress: str(e.quote?.depositAddress),
    intermediaryAddress: str(e.details?.intermediaryAddress),
    messageToSign: str(e.details?.messageToSign),
    messageSigned: e.details?.messageSigned === true,
    networkFee: str(e.details?.networkFee),
    estimatedTime: str(e.details?.estimatedTime),
    amountOut: str(e.quote?.amountOut),
    minAmountOut: str(e.quote?.minAmountOut),
  };
}

interface Deps {
  fetch?: typeof fetch;
  appKey?: string;
  signal?: AbortSignal;
}

async function call(
  path: string,
  init: RequestInit,
  deps: Deps,
): Promise<unknown> {
  const key = appKeyOrThrow(deps.appKey);
  const doFetch = deps.fetch ?? fetch;
  const res = await doFetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-api-key": key },
    signal: deps.signal,
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    // 409 is not a failure the caller should retry — it means this hunter
    // already has one in flight, and the UI must offer to resume it instead.
    throw new ConnectError(
      `aurora connect: ${res.status} ${text.slice(0, 200)}`,
      res.status === 409,
    );
  }
  return text.length === 0 ? {} : JSON.parse(text);
}

/**
 * Create an execution. `dry` prices it without creating anything.
 *
 * `quote.recipient` is deliberately absent: on a bridge-in Aurora rejects it
 * outright, because the recipient IS the intermediary account.
 */
export async function createExecution(
  args: {
    wallet: string;
    quote: ExecutionQuote;
    steps: ExecutionStep[];
    dry?: boolean;
  },
  deps: Deps = {},
): Promise<Execution> {
  if (args.steps.length > MAX_EVM_STEPS) {
    throw new ConnectError(`aurora connect: more than ${MAX_EVM_STEPS} steps`);
  }
  const body = await call(
    `/api/v1/executions/${args.wallet}`,
    {
      method: "POST",
      body: JSON.stringify({
        dry: args.dry === true,
        type: "evm",
        quote: args.quote,
        steps: args.steps,
      }),
    },
    deps,
  );
  return parseExecution(body);
}

export async function listExecutions(
  wallet: string,
  deps: Deps = {},
): Promise<Execution[]> {
  const body = await call(`/api/v1/executions/${wallet}`, { method: "GET" }, deps);
  const rows = (body as { result?: unknown })?.result;
  if (!Array.isArray(rows)) return [];
  const out: Execution[] = [];
  for (const row of rows) {
    try {
      out.push(parseExecution(row));
    } catch {
      // A row we cannot read is dropped: it describes somebody's money in
      // flight, and a half-understood one must not be rendered as a state.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Signing.
//
// NEAR key encoding, not Ethereum hex, and nothing in the OpenAPI spec says so —
// its four fields carry no descriptions at all. Established by probing the live
// API until it accepted one:
//
//   signature = "secp256k1:" + base58( r || s || recoveryId )   65 bytes
//   publicKey = "secp256k1:" + base58( uncompressed key minus its 0x04 )  64
//
// The recovery id is v-27, so 0 or 1 — Ethereum's 27/28 is rejected. And the
// error for a malformed publicKey says "signature is missing the curve prefix",
// naming the wrong field, which is worth knowing before debugging the signature
// that was already correct.
// ---------------------------------------------------------------------------

/** An ERC-191 signature as viem returns it: 0x + r + s + v. */
export function toNearSignature(hexSignature: string): string {
  const raw = Buffer.from(hexSignature.replace(/^0x/, ""), "hex");
  if (raw.length !== 65) {
    throw new ConnectError(`aurora connect: expected 65 signature bytes, got ${raw.length}`);
  }
  const v = raw[64]! >= 27 ? raw[64]! - 27 : raw[64]!;
  if (v !== 0 && v !== 1) {
    throw new ConnectError(`aurora connect: recovery id ${v} is not 0 or 1`);
  }
  const sig = Buffer.concat([raw.subarray(0, 64), Buffer.from([v])]);
  return `secp256k1:${base58.encode(Uint8Array.from(sig))}`;
}

/** The 64-byte public key, NEAR-encoded, derived from a raw private key. */
export function toNearPublicKey(privateKey: string): string {
  const pk = Uint8Array.from(Buffer.from(privateKey.replace(/^0x/, ""), "hex"));
  const uncompressed = secp256k1.getPublicKey(pk, false);
  // Drop the 0x04 tag byte: NEAR carries the 64 coordinate bytes alone.
  return `secp256k1:${base58.encode(Uint8Array.from(uncompressed.slice(1)))}`;
}

export async function submitSignature(
  args: {
    wallet: string;
    executionId: string;
    /** Already NEAR-encoded — see toNearPublicKey. */
    publicKey: string;
    /** Already NEAR-encoded — see toNearSignature. */
    signature: string;
  },
  deps: Deps = {},
): Promise<{ status: string }> {
  const body = await call(
    `/api/v1/executions/${args.wallet}/submit`,
    {
      method: "POST",
      body: JSON.stringify({
        executionId: args.executionId,
        publicKey: args.publicKey,
        signature: args.signature,
      }),
    },
    deps,
  );
  const status = (body as { result?: { status?: unknown } })?.result?.status;
  return { status: typeof status === "string" ? status : "UNKNOWN" };
}
