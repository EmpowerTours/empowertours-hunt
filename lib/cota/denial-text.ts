// Why an order was refused, in the hunter's own language.
//
// Two kinds of refusal reach a hunter and they are NOT the same thing:
//   - a GATE denial (DenyReason) — the signed leash said no;
//   - an EXECUTION refusal (ExecRefusal) — the leash could not be judged at all,
//     so the route failed closed rather than trade blind.
// Both arrive at the UI as a `reason` code, and both must read in es as well as
// en: hunt is served es-first in Mexico, and "your money was not spent, here is
// why" is exactly the sentence a player must not have to translate.
//
// The server keeps returning English `detail` alongside the code for API
// consumers (the Python agent reads it in logs). The browser prefers this table.

import type { DenyReason } from "./enforce";

/** Refusals raised by app/api/cota/trade before or instead of the gate. */
export type ExecRefusal =
  "state_unavailable" | "loss_unverifiable" | "size_zero";

export type RefusalReason = DenyReason | ExecRefusal;

type Lang = "es" | "en";

const TEXT: Record<RefusalReason, Record<Lang, string>> = {
  revoked: {
    en: "You revoked this Cota. Sign a new one to trade again.",
    es: "Revocaste esta Cota. Firma una nueva para volver a operar.",
  },
  not_yet_valid: {
    en: "This Cota hasn't started yet.",
    es: "Esta Cota aún no empieza.",
  },
  expired: {
    en: "This Cota has expired. Sign a new one to keep going.",
    es: "Esta Cota venció. Firma una nueva para continuar.",
  },
  wrong_venue: {
    en: "This Cota doesn't authorise that venue.",
    es: "Esta Cota no autoriza ese mercado.",
  },
  market_not_authorised: {
    en: "This Cota doesn't name that market.",
    es: "Esta Cota no nombra ese activo.",
  },
  notional_exceeded: {
    en: "That order would push your total position past the size you set.",
    es: "Esa orden llevaría tu posición total más allá del tamaño que fijaste.",
  },
  leverage_exceeded: {
    en: "That order asks for more leverage than you allowed.",
    es: "Esa orden pide más apalancamiento del que permitiste.",
  },
  trade_count_exceeded: {
    en: "You've used every trade this Cota allows today.",
    es: "Ya usaste todas las operaciones que esta Cota permite hoy.",
  },
  daily_loss_reached: {
    en: "Today's loss limit is reached. Trading stops until tomorrow.",
    es: "Se alcanzó tu límite de pérdida de hoy. Se detiene hasta mañana.",
  },
  state_unavailable: {
    en: "Couldn't read your live positions, so your size and loss limits can't be checked. Nothing was traded — try again shortly.",
    es: "No se pudieron leer tus posiciones en vivo, así que no se pueden verificar tus límites de tamaño y pérdida. No se operó nada — inténtalo en un momento.",
  },
  loss_unverifiable: {
    en: "Your account holds positions this agent didn't open, so today's loss can't be verified. Trading stops until they're closed or reconciled.",
    es: "Tu cuenta tiene posiciones que este agente no abrió, así que no se puede verificar la pérdida de hoy. Se detiene hasta cerrarlas o reconciliarlas.",
  },
  size_zero: {
    en: "That size is too small to buy one unit at the current price.",
    es: "Ese tamaño es muy pequeño para comprar una unidad al precio actual.",
  },
};

/**
 * The refusal in `lang`.
 *
 * A known code always yields text; an arbitrary string (a `reason` from a server
 * newer than this bundle) yields null, so the caller can fall back to the
 * server's English `detail` rather than print nothing.
 */
export function refusalText(reason: RefusalReason, lang: Lang): string;
export function refusalText(reason: string, lang: Lang): string | null;
export function refusalText(reason: string, lang: Lang): string | null {
  const entry = TEXT[reason as RefusalReason];
  return entry ? entry[lang] : null;
}

/** The English text for a gate denial. `explainDenial` is the server's caller. */
export function denialTextEn(reason: DenyReason): string {
  return TEXT[reason].en;
}
