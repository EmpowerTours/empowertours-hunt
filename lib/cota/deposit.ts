// Fund a Perpl account with AUSD collateral — the step that was missing between
// the MON→AUSD swap and enrolling a trading key.
//
// A hunter cannot enroll a Perpl key (let alone trade) until an on-chain account
// EXISTS. Perpl separates the two: `createAccount(amountCNS)` opens the account
// with initial collateral, `depositCollateral(amount)` tops up an existing one.
// The enrollment "venue refused (404 profile not found)" a hunter hits is simply
// that this step never ran. This is that step.
//
// On-chain, from the hunter's OWN Mera wallet (the account holder): approve AUSD
// to the exchange, then create-or-top-up. Same shape as the MON→AUSD swap.
// Everything here is chain-verified (2026-09-08): the exchange, the AUSD token,
// the two selectors, and the 10-AUSD minimum all read off Perpl's own config and
// bytecode.

import { type Hex, type LocalAccount } from "viem";
import { AUSD_DECIMALS, publicClient, walletClientFor } from "@/lib/cota/swap";

/** Perpl exchange (proxy → impl 0xf7df18…). Holds all AUSD collateral. */
export const PERPL_EXCHANGE_ADDRESS =
  "0x34b6552d57a35a1d042ccae1951bd1c370112a6f" as const;

/** AUSD collateral token on Monad, 6 decimals. */
export const AUSD_ADDRESS =
  "0x00000000efe302beaa2b3e6e1b18d08d69a9012a" as const;

/**
 * Perpl's own minimum to open an account / deposit — 10 AUSD.
 * From /v1/pub/context: min_account_open_amount = min_deposit_amount =
 * 10_000_000 (AUSD, 6dp).
 */
export const MIN_DEPOSIT_6DP = 10_000_000n;

export const AUSD_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const PERPL_ABI = [
  {
    name: "createAccount",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "amountCNS", type: "uint256" }],
    outputs: [],
  },
  {
    name: "depositCollateral",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    name: "withdrawCollateral",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
] as const;

/** Human AUSD string → 6dp integer, or null if malformed / too precise. */
export function parseAusd(input: string): bigint | null {
  const m = input.trim();
  if (m === "" || m === "." || !/^\d*\.?\d*$/.test(m)) return null;
  const [whole, frac = ""] = m.split(".");
  if (frac.length > AUSD_DECIMALS) return null;
  const padded = frac.padEnd(AUSD_DECIMALS, "0");
  return (
    BigInt(whole || "0") * 10n ** BigInt(AUSD_DECIMALS) + BigInt(padded || "0")
  );
}

export type FundResult = {
  action: "create" | "deposit";
  approveTx: Hex | null;
  txHash: Hex;
};

/**
 * Approve AUSD then open (or top up) the hunter's Perpl account.
 *
 * Only a transaction that SIMULATES cleanly is ever sent — so we never waste gas
 * on a revert, and never send a `createAccount` when one already exists (nor a
 * `depositCollateral` when there is no account). First-time hunters create;
 * returning ones top up; the simulation decides which, post-approval.
 */
export async function fundPerpl(
  account: LocalAccount,
  amount6dp: bigint,
): Promise<FundResult> {
  const pub = publicClient();
  const wallet = walletClientFor(account);

  const allowance = (await pub.readContract({
    address: AUSD_ADDRESS,
    abi: AUSD_ABI,
    functionName: "allowance",
    args: [account.address, PERPL_EXCHANGE_ADDRESS],
  })) as bigint;

  let approveTx: Hex | null = null;
  if (allowance < amount6dp) {
    approveTx = await wallet.writeContract({
      address: AUSD_ADDRESS,
      abi: AUSD_ABI,
      functionName: "approve",
      args: [PERPL_EXCHANGE_ADDRESS, amount6dp],
    });
    const r = await pub.waitForTransactionReceipt({ hash: approveTx });
    if (r.status !== "success") throw new Error("AUSD approval failed");
  }

  try {
    await pub.simulateContract({
      account: account.address,
      address: PERPL_EXCHANGE_ADDRESS,
      abi: PERPL_ABI,
      functionName: "createAccount",
      args: [amount6dp],
    });
    const txHash = await wallet.writeContract({
      address: PERPL_EXCHANGE_ADDRESS,
      abi: PERPL_ABI,
      functionName: "createAccount",
      args: [amount6dp],
    });
    const r = await pub.waitForTransactionReceipt({ hash: txHash });
    if (r.status !== "success") throw new Error("createAccount reverted");
    return { action: "create", approveTx, txHash };
  } catch (createErr) {
    // createAccount didn't simulate — the account may already exist. Try a
    // top-up; if that doesn't simulate either, the create error is the
    // informative one (below min, not enough AUSD) so surface it.
    try {
      await pub.simulateContract({
        account: account.address,
        address: PERPL_EXCHANGE_ADDRESS,
        abi: PERPL_ABI,
        functionName: "depositCollateral",
        args: [amount6dp],
      });
    } catch {
      throw createErr;
    }
    const txHash = await wallet.writeContract({
      address: PERPL_EXCHANGE_ADDRESS,
      abi: PERPL_ABI,
      functionName: "depositCollateral",
      args: [amount6dp],
    });
    const r = await pub.waitForTransactionReceipt({ hash: txHash });
    if (r.status !== "success") throw new Error("depositCollateral reverted");
    return { action: "deposit", approveTx, txHash };
  }
}

export function explainDepositError(err: unknown, lang: "es" | "en"): string {
  const msg = String(
    (err as { shortMessage?: string; message?: string })?.shortMessage ??
      (err as Error)?.message ??
      err,
  );
  if (/reject|denied|cancel|User/i.test(msg))
    return lang === "es"
      ? "Cancelaste la firma. Toca de nuevo para reintentar."
      : "You cancelled the signature. Tap again to retry.";
  if (/insufficient|balance|exceeds|transfer amount/i.test(msg))
    return lang === "es"
      ? "No tienes suficiente AUSD. Cambia más MON primero."
      : "Not enough AUSD in your wallet. Swap more MON first.";
  return lang === "es"
    ? `Falló el depósito: ${msg.slice(0, 140)}`
    : `Deposit failed: ${msg.slice(0, 140)}`;
}
