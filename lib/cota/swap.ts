import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  type LocalAccount,
} from "viem";
import { monad } from "@/lib/monad";

// ---------------------------------------------------------------------------
// MON -> AUSD swap desk (MonAusdSwap), live on Monad mainnet. A hunter with only
// MON sends it here and receives AUSD to fund a Perpl account. The desk holds an
// operator-seeded AUSD float and pays out at an operator-maintained rate with a
// staleness guard. See memory: reference_mon_ausd_swap_mainnet.
// ---------------------------------------------------------------------------

export const SWAP_ADDRESS =
  "0x64C549C589229f8E5b5F9991766d5604df6Aa544" as const;
export const AUSD_DECIMALS = 6;

export const SWAP_ABI = [
  {
    type: "function",
    name: "quote",
    stateMutability: "view",
    inputs: [{ name: "monInWei", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "available",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "swap",
    stateMutability: "payable",
    inputs: [{ name: "minAusdOut", type: "uint256" }],
    outputs: [{ name: "ausdOut", type: "uint256" }],
  },
] as const;

export function publicClient() {
  return createPublicClient({ chain: monad, transport: http() });
}

export function walletClientFor(account: LocalAccount) {
  return createWalletClient({ account, chain: monad, transport: http() });
}

/**
 * The minimum AUSD to accept, given a fresh quote and a slippage floor in bps
 * (100 = 1%). Passed to swap() so a price move between quote and execution
 * reverts instead of shortchanging the hunter.
 */
export function minOut(quote: bigint, slippageBps = 100n): bigint {
  return (quote * (10_000n - slippageBps)) / 10_000n;
}

export function formatAusd(amount6dp: bigint): string {
  return formatUnits(amount6dp, AUSD_DECIMALS);
}

/** Turn a revert/RPC error into one honest sentence for the hunter. */
export function explainSwapError(err: unknown, lang: "es" | "en"): string {
  const msg = String((err as { message?: string })?.message ?? err);
  const es = lang === "es";
  if (/desk out of AUSD/i.test(msg))
    return es
      ? "La caja no tiene AUSD ahora mismo. Hay que recargarla."
      : "The desk is out of AUSD right now — it needs a top-up.";
  if (/rate stale/i.test(msg))
    return es
      ? "El precio está desactualizado. Intenta de nuevo en un momento."
      : "The price is stale — try again in a moment.";
  if (/slippage/i.test(msg))
    return es
      ? "El precio se movió más allá de tu límite. Intenta de nuevo."
      : "The price moved past your slippage limit. Try again.";
  if (/address cap/i.test(msg))
    return es
      ? "Alcanzaste el límite por billetera de esta caja."
      : "You've hit the per-wallet limit for this desk.";
  if (/daily limit/i.test(msg))
    return es
      ? "Se alcanzó el límite diario de la caja. Intenta mañana."
      : "The desk's daily limit is reached. Try again tomorrow.";
  if (/amount too small/i.test(msg))
    return es
      ? "Es muy poco MON para comprar algo de AUSD."
      : "That's too little MON to buy any AUSD.";
  if (/insufficient funds|exceeds the balance/i.test(msg))
    return es
      ? "No hay suficiente MON en tu billetera Cota para esto + gas."
      : "Not enough MON in your Cota wallet for this swap + gas.";
  return es ? "Falló el swap." : "Swap failed.";
}
