// ---------------------------------------------------------------------------
// What the player is about to agree to, in sentences.
//
// This is the product's whole claim. A bound nobody can read is not a bound —
// it is a form somebody filled in — and the difference between those two things
// is the only reason to sign a Cota rather than hand over an API key.
//
// ## Rendered from the signed integers, never from the form
//
// Every line below is derived from the scaled values that go into the EIP-712
// message, not from the input boxes that produced them. If a form field said
// "3.005" and the signed value is 3.00, the read-back must say 3.00 — because
// the number in the signature is the number that will be enforced. Reading back
// the form instead would show the player a promise the signature does not make,
// which is the exact failure this file exists to prevent.
//
// (In practice lib/cota/scale.ts refuses 3.005 outright rather than rounding
// it, so the two agree. This file does not rely on that: it reads the integers.)
//
// Pure and side-effect free, so the sentences can be tested rather than eyeballed.
// ---------------------------------------------------------------------------

import { fromLeverageX100, fromUsdE6 } from "./scale";
import type { CotaMessage } from "./typedData";

/** The ceilings alone — everything a bound promises that has no clock in it. */
export type CotaDraft = Pick<
  CotaMessage,
  | "venue"
  | "markets"
  | "maxNotionalUsdE6"
  | "maxLeverageX100"
  | "maxDailyLossUsdE6"
  | "maxTradesPerDay"
>;

/**
 * When the bound stops.
 *
 * Two forms, because before a signature exists there is no absolute date to
 * show: the window starts when the player signs, not when the page loaded.
 * Rendering a date computed at page load would print a promise a minute or an
 * hour off from the one actually signed, and would also drag a clock read into
 * render, where it makes the message change on every re-render.
 */
export type Expiry =
  | { kind: "at"; unixSeconds: bigint }
  | { kind: "afterSigning"; days: number };

/** One clause of the agreement, in both languages. */
export interface ReadbackLine {
  /** Stable key, for React and for tests that should not depend on wording. */
  id: string;
  es: string;
  en: string;
  /**
   * True for the clauses that limit loss. The UI leads with these: they are
   * what the player is actually protected by, and burying them under venue and
   * market names is how a disclosure becomes decoration.
   */
  protective: boolean;
}

const MONTHS_ES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

const MONTHS_EN = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * Dates are rendered in UTC, matching the day the ceilings reset on.
 *
 * Showing a local date beside a limit that resets at UTC midnight would print
 * two different days on the same screen, and the player would be right to
 * believe whichever one we showed them.
 */
function formatDate(unixSeconds: bigint, months: string[]): string {
  const d = new Date(Number(unixSeconds) * 1000);
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function marketList(markets: readonly string[]): string {
  return markets.join(", ");
}

/**
 * The agreement as a list of clauses.
 *
 * Order is deliberate: what it authorises, then every way it stops. A player
 * who reads only the first two lines should still have seen the permission;
 * a player who reads to the end has seen every limit.
 */
export function readback(draft: CotaDraft, expiry: Expiry): ReadbackLine[] {
  const message = draft;
  const lines: ReadbackLine[] = [];

  // An empty market list is a real, signable state: a Cota naming no market
  // authorises nothing, which is a revocation the player can prove they made.
  // It must not render as though it permitted everything.
  if (message.markets.length === 0) {
    lines.push({
      id: "nothing",
      es: "Esta Cota no autoriza ningún mercado. No se puede operar con ella.",
      en: "This Cota authorises no market. Nothing can be traded with it.",
      protective: true,
    });
    return lines;
  }

  lines.push({
    id: "venue",
    es: `Autorizas operar en ${message.venue}, únicamente en ${marketList(message.markets)}.`,
    en: `You authorise trading on ${message.venue}, in ${marketList(message.markets)} only.`,
    protective: false,
  });

  lines.push({
    id: "notional",
    es: `Nunca más de $${fromUsdE6(message.maxNotionalUsdE6)} abiertos en total, sumando todas las posiciones.`,
    en: `Never more than $${fromUsdE6(message.maxNotionalUsdE6)} open in total, across every position at once.`,
    protective: true,
  });

  lines.push({
    id: "leverage",
    es: `Apalancamiento máximo ${fromLeverageX100(message.maxLeverageX100)}x.`,
    en: `Leverage never above ${fromLeverageX100(message.maxLeverageX100)}x.`,
    protective: true,
  });

  lines.push({
    id: "loss",
    es: `Si vas $${fromUsdE6(message.maxDailyLossUsdE6)} abajo en el día — esté cerrada la pérdida o no — se deja de abrir posiciones hasta mañana. Las que ya están abiertas se dejan recuperar: nada se cierra con pérdida.`,
    en: `If you are $${fromUsdE6(message.maxDailyLossUsdE6)} down on the day — whether or not the loss has been closed — no new positions open until tomorrow. Anything already open is left to recover: nothing is closed at a loss.`,
    protective: true,
  });

  lines.push({
    id: "trades",
    es: `Como máximo ${message.maxTradesPerDay} ${message.maxTradesPerDay === 1 ? "operación" : "operaciones"} por día.`,
    en: `At most ${message.maxTradesPerDay} ${message.maxTradesPerDay === 1 ? "trade" : "trades"} a day.`,
    protective: true,
  });

  lines.push(
    expiry.kind === "at"
      ? {
          id: "expiry",
          es: `Vence el ${formatDate(expiry.unixSeconds, MONTHS_ES)}. Después de esa fecha no se abre nada nuevo.`,
          en: `Expires ${formatDate(expiry.unixSeconds, MONTHS_EN)}. After that, nothing new is opened.`,
          protective: true,
        }
      : {
          id: "expiry",
          es: `Vence ${expiry.days} ${expiry.days === 1 ? "día" : "días"} después de firmarla. Después no se abre nada nuevo.`,
          en: `Expires ${expiry.days} ${expiry.days === 1 ? "day" : "days"} after you sign it. After that, nothing new is opened.`,
          protective: true,
        },
  );

  lines.push({
    id: "revoke",
    es: "Puedes revocarla cuando quieras. Al revocarla no se abre nada nuevo; tú decides qué hacer con lo que ya esté abierto.",
    en: "You can revoke it at any time. Revoking stops anything new from opening; what to do with an open position stays your call.",
    protective: true,
  });

  return lines;
}

/** A signed message read back against its own absolute expiry. */
export function readbackOf(message: CotaMessage): ReadbackLine[] {
  return readback(message, { kind: "at", unixSeconds: message.notAfter });
}

/**
 * The one-line summary, for a confirmation button or a list row.
 *
 * Leads with the loss ceiling rather than the venue. If a player remembers one
 * number from this screen it should be the one that bounds what they can lose.
 */
export function readbackSummary(
  message: CotaDraft,
  lang: "es" | "en",
): string {
  if (message.markets.length === 0) {
    return lang === "es" ? "No autoriza nada." : "Authorises nothing.";
  }
  const loss = `$${fromUsdE6(message.maxDailyLossUsdE6)}`;
  const size = `$${fromUsdE6(message.maxNotionalUsdE6)}`;
  const lev = `${fromLeverageX100(message.maxLeverageX100)}x`;
  return lang === "es"
    ? `Máx. ${loss} de pérdida al día · hasta ${size} abiertos · ${lev}`
    : `Max ${loss} loss a day · up to ${size} open · ${lev}`;
}
