// ---------------------------------------------------------------------------
// What a hunter can safely send to their deposit address.
//
// WHY THIS EXISTS, stated plainly because it is a money-loss bug and not a
// nicety. Aurora's own documentation on persistent deposit addresses:
//
//   "the deposit may not be processed, and the funds can be difficult or
//    impossible to recover"
//
// ...for an asset that is not on the supported list, or one sent on a chain
// outside the address's depositChain. There is no bounce and no refund — a
// persistent deposit address takes no `refundTo` at all, so nothing knows where
// to send it back to. The failure is silent and permanent.
//
// The funding screen shipped with the copy "send whatever you hold, from
// wherever it sits". That sentence invites exactly the deposit that strands, so
// the list below replaces it with the truth.
//
// A HARDCODED LIST WOULD ROT, and rot here costs a hunter their money rather
// than a render. Aurora publishes the live set, and — unlike every other
// endpoint in this integration — it needs no API key, so it can be fetched on a
// screen that must work whether or not the key is configured.
//
// Different host from the rest: intents-connect-api, not intents-api.
// ---------------------------------------------------------------------------

const TOKENS_API =
  process.env.AURORA_INTENTS_TOKENS_URL ??
  "https://intents-connect-api.aurora.dev";

/** An origin asset Aurora will accept and convert. */
export interface SupportedToken {
  assetId: string;
  symbol: string;
  /** Aurora's chain key — `base`, `eth`, `arb`, `sol`… */
  blockchain: string;
  /** Empty for a chain's native coin. */
  contractAddress: string;
  decimals: number;
}

/**
 * An EVM address is the same 20 bytes everywhere, which is the ONLY reason one
 * `evm` deposit address can accept funds from many chains. So the question
 * "can this chain reach my address" is really "does this chain use 0x
 * addresses" — and rather than keep a list of which chains are EVM and watch it
 * drift, we read it out of Aurora's own data: a chain whose tokens carry 0x
 * contract addresses is a chain whose addresses look like ours.
 *
 * Native coins carry no contract address, so a chain is judged by any token on
 * it that has one.
 */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function parseSupportedTokens(body: unknown): SupportedToken[] {
  const rows = (body as { result?: { in?: unknown } })?.result?.in;
  if (!Array.isArray(rows)) return [];
  const out: SupportedToken[] = [];
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    // A token we cannot name or place is a token we must not tell anyone to
    // send. Dropped, never guessed at.
    if (typeof r.symbol !== "string" || r.symbol.length === 0) continue;
    if (typeof r.blockchain !== "string" || r.blockchain.length === 0) continue;
    if (typeof r.assetId !== "string") continue;
    out.push({
      assetId: r.assetId,
      symbol: r.symbol,
      blockchain: r.blockchain,
      contractAddress:
        typeof r.contractAddress === "string" ? r.contractAddress : "",
      decimals: typeof r.decimals === "number" ? r.decimals : 0,
    });
  }
  return out;
}

/** Chains whose addresses have the same shape as an `evm` deposit address. */
export function evmChains(tokens: readonly SupportedToken[]): string[] {
  const evm = new Set<string>();
  for (const t of tokens) {
    if (EVM_ADDRESS.test(t.contractAddress)) evm.add(t.blockchain);
  }
  return [...evm].sort();
}

/**
 * What to show a hunter holding an `evm` address: every chain that can reach it
 * and what may be sent from each.
 *
 * Monad is dropped. It is a supported chain, but a hunter whose USDC is already
 * on Monad does not need a cross-chain deposit — sending it here would pay a
 * bridge fee to move money in a circle.
 */
export function evmDepositOptions(
  tokens: readonly SupportedToken[],
): Array<{ chain: string; symbols: string[] }> {
  const reachable = new Set(evmChains(tokens));
  const byChain = new Map<string, Set<string>>();
  for (const t of tokens) {
    if (!reachable.has(t.blockchain)) continue;
    if (t.blockchain === "monad") continue;
    // Aurora still lists these — `USDT0(DEPRECATED)`, `XPL_(DEPRECATED)` on
    // plasma — and they may well still bridge. But this list is read as
    // instructions for where to send money, and telling a hunter to send a
    // token its own issuer has retired is not advice worth giving.
    if (/deprecated/i.test(t.symbol)) continue;
    const set = byChain.get(t.blockchain) ?? new Set<string>();
    set.add(t.symbol);
    byChain.set(t.blockchain, set);
  }
  return [...byChain.entries()]
    .map(([chain, symbols]) => ({ chain, symbols: [...symbols].sort() }))
    .sort((a, b) => a.chain.localeCompare(b.chain));
}

export async function fetchSupportedTokens(
  deps: {
    fetch?: typeof fetch;
    signal?: AbortSignal;
  } = {},
): Promise<SupportedToken[]> {
  const doFetch = deps.fetch ?? fetch;
  const res = await doFetch(
    `${TOKENS_API}/api/v1/supported_tokens?flow=inOperation`,
    { signal: deps.signal, cache: "no-store" },
  );
  if (!res.ok) throw new Error(`aurora: supported_tokens ${res.status}`);
  return parseSupportedTokens(await res.json());
}
