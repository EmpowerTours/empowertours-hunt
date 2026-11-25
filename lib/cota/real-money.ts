// Real-money Cota is founder-only until Hunt is registered for Acuerdo 115/2026.
//
// Every server path that can put a hunter's money at risk (open an order,
// authorise a leash, grant autonomy, store a trading key, enrol a Perpl key,
// issue an Aurora deposit address) asks `realMoneyAllowed` first. The Perpl
// transport (`placeOrder`) asks again for any order that OPENS exposure, so a
// route that forgets the check still cannot open a position.
//
// ## Fails closed
//
// The allowlist is `COTA_REAL_MONEY_ALLOWLIST`, a comma-separated list of wallet
// addresses. Unset, empty, or holding nothing that parses as an address means
// NOBODY is allowed. An entry that is not an address is ignored rather than
// trusted, and it never widens the list.
//
// ## What stays open
//
// Getting money OUT stays open to everyone, because a gate that traps funds is
// worse than no gate: closing or reducing a Perpl position (/api/cota/close),
// revoking a leash, turning autonomy off, and withdrawing from Kuru to the
// hunter's own wallet (signed in the browser). Read-only market data and the
// play-chip game do not touch real money and are not gated.

import { getAddress, isAddress } from "viem";

export const REAL_MONEY_ENV = "COTA_REAL_MONEY_ALLOWLIST";

/** The reason code every refusal carries, so a client can match on it. */
export const REAL_MONEY_CLOSED = "real_money_closed" as const;

/** The notice shown to a hunter who is not allowlisted. */
export const REAL_MONEY_CLOSED_TEXT = {
  en: "Real-money trading is closed for now.",
  es: "El trading con dinero real está cerrado por ahora.",
} as const;

/** Checksummed form of `addr`, or null if it is not an address. */
function normalise(addr: string): string | null {
  const a = addr.trim();
  if (!isAddress(a, { strict: false })) return null;
  return getAddress(a);
}

/**
 * The parsed allowlist. Read from the environment on every call, so a changed
 * variable takes effect on the next request rather than at the next build.
 */
export function realMoneyAllowlist(
  raw: string | undefined = process.env[REAL_MONEY_ENV],
): ReadonlySet<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const part of raw.split(",")) {
    if (part.trim() === "") continue;
    const a = normalise(part);
    if (a) out.add(a);
  }
  return out;
}

/**
 * Whether `wallet` may use real-money Cota. False for a missing or malformed
 * address and for any address when the allowlist is empty.
 */
export function realMoneyAllowed(
  wallet: string | null | undefined,
  raw: string | undefined = process.env[REAL_MONEY_ENV],
): boolean {
  if (!wallet) return false;
  const a = normalise(wallet);
  if (!a) return false;
  return realMoneyAllowlist(raw).has(a);
}

/** The JSON body every gated route returns with HTTP 403. */
export function realMoneyClosedBody(): {
  error: string;
  reason: typeof REAL_MONEY_CLOSED;
} {
  return { error: REAL_MONEY_CLOSED_TEXT.en, reason: REAL_MONEY_CLOSED };
}
