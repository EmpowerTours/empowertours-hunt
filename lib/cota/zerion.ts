// ---------------------------------------------------------------------------
// What a hunter actually holds, read from Zerion.
//
// WHY, narrowly. The funding screen tells someone an address and the arrivals
// list tells them what Aurora says it sent. Neither tells them what they have.
// "Swap USDC -> AUSD" is a button with no meaning next to a balance you cannot
// see, and a hunter who is not sure the money landed will not press it.
//
// WHAT THIS IS NOT. Zerion answers per ADDRESS, and the only address we know is
// the passkey-derived one — new, and for almost every hunter holding nothing
// outside Monad. It cannot see the MetaMask or the exchange their outside money
// actually sits in, and nothing here should imply otherwise. If a non-Monad row
// does appear it is a genuine find and worth showing, but it is not the point.
//
// THE KEY IS SERVER-SIDE. Zerion's own docs distinguish a public client key
// from a private one, and ours is neither obviously — so it is treated as
// secret: this module runs only on the server and the route passes the session
// wallet, never a caller-supplied address. Otherwise anyone could read any
// wallet through our quota.
//
// Auth is HTTP Basic with the key as the username and an EMPTY password — not
// a bearer token. Measured against the live API 2026-09-22; a bearer header
// returns 401.
// ---------------------------------------------------------------------------

const ZERION_API = process.env.ZERION_API_URL ?? "https://api.zerion.io";

export class ZerionError extends Error {}

/** One token a wallet holds, on one chain. */
export interface Holding {
  symbol: string;
  /** Zerion's chain key — `monad`, `base`, `ethereum`… */
  chain: string;
  /** Human units as a STRING, exactly as Zerion formatted it. Display only. */
  amount: string;
  /** Smallest units, for anything that must be exact. */
  amountInt: string;
  decimals: number;
  /** USD, or null when Zerion has no price. Never defaulted to zero. */
  valueUsd: number | null;
}

function apiKey(explicit?: string): string {
  const key = explicit ?? process.env.ZERION_API_KEY;
  if (!key) throw new ZerionError("ZERION_API_KEY is not set");
  return key;
}

/**
 * Rows that cannot be read are dropped rather than guessed at, and a row
 * missing its amount is dropped rather than shown as zero.
 *
 * The distinction matters more here than in most parsers: every row is a claim
 * about how much money somebody has. A wrong number is worse than a missing
 * one, because a hunter will act on it.
 */
export function parseHoldings(body: unknown): Holding[] {
  const rows = (body as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return [];
  const out: Holding[] = [];
  for (const row of rows) {
    const r = row as {
      attributes?: {
        quantity?: { int?: unknown; decimals?: unknown; numeric?: unknown };
        value?: unknown;
        fungible_info?: { symbol?: unknown };
      };
      relationships?: { chain?: { data?: { id?: unknown } } };
    };
    const symbol = r.attributes?.fungible_info?.symbol;
    const chain = r.relationships?.chain?.data?.id;
    const q = r.attributes?.quantity;
    if (typeof symbol !== "string" || symbol.length === 0) continue;
    if (typeof chain !== "string" || chain.length === 0) continue;
    // `numeric` is the string Zerion already formatted. `float` exists too and
    // is deliberately unused: it is a double, and a double is the wrong type
    // for a balance.
    if (typeof q?.numeric !== "string") continue;
    out.push({
      symbol,
      chain,
      amount: q.numeric,
      amountInt: typeof q.int === "string" ? q.int : "",
      decimals: typeof q.decimals === "number" ? q.decimals : 0,
      valueUsd:
        typeof r.attributes?.value === "number" ? r.attributes.value : null,
    });
  }
  return out;
}

/**
 * Monad first, then by value.
 *
 * The hunter is on a Monad app deciding whether to swap a Monad balance, so
 * what is on Monad is what they came to see. Everything else is context.
 */
export function orderForFunding(holdings: readonly Holding[]): Holding[] {
  return [...holdings].sort((a, b) => {
    if (a.chain !== b.chain) {
      if (a.chain === "monad") return -1;
      if (b.chain === "monad") return 1;
    }
    return (b.valueUsd ?? 0) - (a.valueUsd ?? 0);
  });
}

export async function fetchHoldings(
  walletAddress: string,
  deps: { fetch?: typeof fetch; apiKey?: string; signal?: AbortSignal } = {},
): Promise<Holding[]> {
  const key = apiKey(deps.apiKey);
  const doFetch = deps.fetch ?? fetch;
  const url =
    `${ZERION_API}/v1/wallets/${encodeURIComponent(walletAddress)}/positions/` +
    `?filter[positions]=only_simple&currency=usd`;
  const res = await doFetch(url, {
    headers: {
      accept: "application/json",
      // Basic, username = key, empty password. Not a bearer token.
      authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`,
    },
    signal: deps.signal,
    cache: "no-store",
  });
  if (!res.ok) throw new ZerionError(`zerion: positions ${res.status}`);
  return orderForFunding(parseHoldings(await res.json()));
}
