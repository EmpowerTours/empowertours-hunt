import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  type LocalAccount,
} from "viem";
import { monad, monadRpcUrl } from "@/lib/monad";

// ---------------------------------------------------------------------------
// MON -> AUSD swap desk (MonAusdSwapOracle), live on Monad mainnet. A hunter
// with only MON sends it here and receives AUSD to fund a Perpl account. No
// other route crosses native MON into AUSD on Monad — every AUSD pool on
// Uniswap V3 holds about a dollar a side — which is why the desk exists.
//
// The desk prices itself from Chainlink MON/USD and AUSD/USD read at call time
// and charges 100 bps. Its predecessor (0x64C549…Aa544, now drained and paused)
// carried an operator-set rate that went 4.9 days stale and quoted MON 12.9%
// above market; there is no rate to maintain here and no key that could.
//
// Consequence for this file: the desk HALTS rather than quoting a price it
// cannot vouch for, so a refusal is normal operation, not a fault. Every revert
// string it can produce is mapped in explainSwapError below — and on Monad a
// reverted swap burns the caller's whole gas limit, so the page must simulate
// before it lets anyone sign.
// ---------------------------------------------------------------------------

export const SWAP_ADDRESS =
  "0x273b43e8E69E8c252e8470e9BB3C577331Ec52DE" as const;
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

// Both take the URL explicitly. `http()` bare is the bug documented on
// monadRpcUrl: it ignores MONAD_RPC_URL and quietly uses the public endpoint.
export function publicClient() {
  return createPublicClient({ chain: monad, transport: http(monadRpcUrl()) });
}

export function walletClientFor(account: LocalAccount) {
  return createWalletClient({
    account,
    chain: monad,
    transport: http(monadRpcUrl()),
  });
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

  // The desk halted because a price could not be vouched for. Not a fault, and
  // it clears itself when the feed posts its next round.
  if (/feed stale|bad price|incomplete round|feed future/i.test(msg))
    return es
      ? "El precio está desactualizado. Intenta de nuevo en unos minutos."
      : "The price feed is stale — try again in a few minutes.";
  if (/price out of band/i.test(msg))
    return es
      ? "El precio está fuera del rango normal, así que la caja se detuvo. Intenta más tarde."
      : "The price is outside its normal range, so the desk stopped. Try later.";
  if (/feed decimals changed/i.test(msg))
    return es
      ? "La caja se detuvo por un cambio en el oráculo. Ya lo estamos revisando."
      : "The desk stopped because its price oracle changed. We're on it.";

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
  if (/not allowed/i.test(msg))
    return es
      ? "Esta caja está limitada a billeteras aprobadas."
      : "This desk is limited to approved wallets.";
  if (/Pausable: paused/i.test(msg))
    return es
      ? "La caja está cerrada temporalmente."
      : "The desk is closed for now.";

  // minSwapAusd: the desk refuses a payout too small to be worth the gas. Its
  // predecessor's only real swap ever paid out 0.078 AUSD.
  if (/below minimum|amount too small/i.test(msg))
    return es
      ? "Es muy poco MON — el mínimo es 1 AUSD (unos 44 MON)."
      : "That's too little MON — the minimum is 1 AUSD (about 44 MON).";

  if (/transfer amount mismatch/i.test(msg))
    return es
      ? "La caja canceló el pago por una discrepancia. No se gastó nada."
      : "The desk cancelled the payout over a mismatch. Nothing was spent.";
  if (/insufficient funds|exceeds the balance/i.test(msg))
    return es
      ? "No hay suficiente MON en tu billetera Cota para esto + gas."
      : "Not enough MON in your Cota wallet for this swap + gas.";
  return es ? "Falló el swap." : "Swap failed.";
}

// ---------------------------------------------------------------------------
// How much MON to hold back from a max-size swap so it can pay its own gas.
//
// The page kept a flat `parseEther("0.05")`. Unlike the spot screen's identical
// constant — which was smaller than the gas on every trade it ever made — this
// one is currently ADEQUATE: a desk swap costs 291,983 gas, so 0.0298 MON at
// the 102 gwei that trades have been landing at.
//
// It is adequate by luck rather than by construction. 0.05 MON stops covering
// this swap at 171 gwei, and Kuru's own quote endpoint has been quoting 130 in
// its "rapid" tier and 180 in "extreme" today. Nothing connects the constant to
// the thing it is supposed to cover, so the day it stops being true nothing
// says so — the hunter just gets a max-size swap their wallet cannot sign.
//
// Measured 2026-09-21 with eth_estimateGas against the live desk from an
// address with no swap history: 291,983 gas at 50, 100, 200, 400 and 480 MON —
// flat, because the desk does the same work whatever the size. Sizes below
// ~40 MON revert "below minimum" and this wallet's own reads revert "address
// cap", so the measurement had to come from a fresh sender.
// ---------------------------------------------------------------------------

/** Measured, not estimated at call time. Flat across every size that clears. */
export const SWAP_GAS_MEASURED = 291_983n;

/**
 * Doubled, and the doubling is doing two jobs: covering execution that runs
 * heavier than the sample, and covering the gas price moving between rendering
 * this number and signing. Monad charges the whole limit with no refund, so a
 * reserve that is too thin does not cost a little — it costs the transaction.
 *
 * Unspent MON stays the hunter's, so the only cost of being generous is a max
 * button that offers slightly less than the theoretical maximum.
 */
export function swapGasReserveWei(gasPriceWei: bigint): bigint {
  return SWAP_GAS_MEASURED * gasPriceWei * 2n;
}
