// Turn ON order forwarding for the hunter's Perpl account — the one switch that
// stood between a correctly-built order and a fill.
//
// A Perpl account created through the API starts with forwarding OFF. With it
// off the gateway ACCEPTS an order (code 0) and the chain refuses it, so an
// unexecutable order is indistinguishable from an ordinary non-fill. Both
// accounts we have ever opened defaulted this way: Mandate's 5103 in August and
// the hunt hunter's 5273 on 2026-09-13.
//
// What it actually is (read off Perpl's own app bundle, 2026-09-14): the
// "1-click trading" toggle in Perpl's settings is not a venue-side preference
// at all — it sends `allowOrderForwarding(bool)` to the exchange contract from
// the ACCOUNT HOLDER'S OWN WALLET. Selector 0x7962f910, present in the live
// implementation at 0xf7df18…cd33 behind the exchange proxy; the contract emits
// OrderForwardingUpdated(accountId, allowed). So a hunter who never opens
// Perpl's own web app can never have it on, and no amount of re-enrolling a key
// changes it — the flag hangs off the account, not the key.
//
// Which also means Hunt can send it itself, from the same Mera wallet that did
// the approve and the createAccount. That is this file.
//
// Simulate first, always: on Monad a reverted transaction burns the caller's
// whole gas limit rather than refunding it, and this call reverts for an
// address with no Perpl account yet.

import { type Hex, type LocalAccount } from "viem";
import { publicClient, walletClientFor } from "@/lib/cota/swap";
import { PERPL_EXCHANGE_ADDRESS } from "@/lib/cota/deposit";

export const FORWARDING_ABI = [
  {
    name: "allowOrderForwarding",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "allow", type: "bool" }],
    outputs: [],
  },
] as const;

/**
 * Set order forwarding on the caller's Perpl account and wait for the receipt.
 *
 * There is no on-chain view of the current flag — the venue reports it as `fw`
 * on the wallet snapshot (mt 19) and nowhere else — so this does not try to
 * skip a redundant write. Setting it to the value it already holds is a
 * successful no-op that costs about 71k gas; that is the price of not guessing.
 *
 * Throws if the account does not exist yet (the simulation catches it before
 * any gas is spent) or if the transaction reverts.
 */
export async function setOrderForwarding(
  account: LocalAccount,
  allow: boolean,
): Promise<Hex> {
  const pub = publicClient();
  const wallet = walletClientFor(account);

  await pub.simulateContract({
    account: account.address,
    address: PERPL_EXCHANGE_ADDRESS,
    abi: FORWARDING_ABI,
    functionName: "allowOrderForwarding",
    args: [allow],
  });

  const txHash = await wallet.writeContract({
    address: PERPL_EXCHANGE_ADDRESS,
    abi: FORWARDING_ABI,
    functionName: "allowOrderForwarding",
    args: [allow],
  });
  const r = await pub.waitForTransactionReceipt({ hash: txHash });
  if (r.status !== "success") throw new Error("allowOrderForwarding reverted");
  return txHash;
}

export function explainForwardingError(
  err: unknown,
  lang: "es" | "en",
): string {
  const msg = String(
    (err as { shortMessage?: string; message?: string })?.shortMessage ??
      (err as Error)?.message ??
      err,
  );
  if (/reject|denied|cancel|User/i.test(msg))
    return lang === "es"
      ? "Cancelaste la firma. Toca de nuevo para reintentar."
      : "You cancelled the signature. Tap again to retry.";
  // The simulation refuses before anything is spent when there is no account.
  if (/revert|execution reverted|AccountDoesNotExist/i.test(msg))
    return lang === "es"
      ? "Primero abre y fondea tu cuenta Perpl; sin cuenta no hay nada que activar."
      : "Open and fund your Perpl account first — with no account there is nothing to switch on.";
  return lang === "es"
    ? `No se pudo activar el reenvío: ${msg.slice(0, 140)}`
    : `Could not enable forwarding: ${msg.slice(0, 140)}`;
}
