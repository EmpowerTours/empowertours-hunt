// Linking a hunt player to their TURBO builder identity.
//
// ## Why this is a claim and not a proof
//
// There is no TURBO registry CONTRACT to check against — the handle is a
// GitHub username, and the admin player page links to github.com/<handle>. So
// nothing here can verify ownership, and pretending otherwise would be worse
// than being explicit: this is a self-declared label.
//
// What makes that proportionate is where the handle actually gets used. Credit
// is not withdrawable and a redemption is settled BY HAND by an operator who
// can see the handle (prisma `model Redemption`, app/admin/redemptions). The
// handle is the instruction on that manual payment, not an authorisation to
// move money. Gating it behind a signature would also be stricter than
// /api/redeem, which SPENDS the credit on a session alone.
//
// ## Why it is set once
//
// `app/api/register/route.ts` already refuses to re-point a handle on a repeat
// registration, calling it "a credit-redirection primitive" — and it is right.
// Credit accrues to a wallet over weeks and is then redeemed against whatever
// handle the row happens to name at that moment, so a freely mutable handle
// lets somebody bank credit and redirect it at settlement time. One-time-set
// closes that, and an audited admin override handles the typo case without
// reopening it.
//
// Pure: no database, no clock, no network. The route enforces uniqueness and
// the set-once rule with atomic SQL, for the same reason every ceiling in this
// schema is a conditional UPDATE — a predicate checked in application code is
// a read-then-write.

/**
 * Same shape `app/api/register/route.ts` already accepts, deliberately.
 *
 * Looser than GitHub's real rule, which forbids underscores and consecutive
 * hyphens. Matching the existing regex matters more than being strict: a
 * handle that registration would have accepted must not be refused here, or
 * the two paths disagree about what a valid identity is. The cost of the
 * looseness is a handle that resolves to no GitHub profile, which an operator
 * sees before settling anything.
 */
export const TURBO_HANDLE_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9-_]{0,37}[A-Za-z0-9])?$/;

export const TURBO_HANDLE_MAX = 39;

export const TURBO_LINK_REFUSALS = [
  "empty",
  "too_long",
  "bad_characters",
  // Set once. Changing it is an operator action, with an audit row.
  "already_linked",
  // Another wallet claims it. Two players redeeming against one builder
  // identity is exactly the collision the handle exists to prevent.
  "taken",
] as const;
export type TurboLinkRefusal = (typeof TURBO_LINK_REFUSALS)[number];

export type TurboHandleCheck =
  { ok: true; handle: string } | { ok: false; reason: TurboLinkRefusal };

/**
 * Trim and validate a submitted handle.
 *
 * A leading "@" is stripped rather than rejected: it is how people write a
 * handle everywhere else, and refusing it would be a puzzle rather than a
 * rule.
 *
 * LOWERCASED, and that is a storage decision as much as a formatting one.
 * GitHub handles are case-insensitive, so "EmpowerTours" and "empowertours"
 * are one builder identity — and the whole point of the unique constraint is
 * that two wallets cannot claim one identity by changing a capital. Prisma
 * cannot express a functional unique index (`lower(...)`), so the stored form
 * has to BE the comparison form or the constraint does not hold. The cost is
 * display case, which GitHub shows correctly on the profile anyway.
 */
export function normaliseHandle(raw: string): TurboHandleCheck {
  const trimmed = raw.trim().replace(/^@+/, "");
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (trimmed.length > TURBO_HANDLE_MAX) {
    return { ok: false, reason: "too_long" };
  }
  if (!TURBO_HANDLE_RE.test(trimmed)) {
    return { ok: false, reason: "bad_characters" };
  }
  return { ok: true, handle: trimmed.toLowerCase() };
}

/**
 * The comparison key for uniqueness.
 *
 * `normaliseHandle` already lowercases, so this is the identity function for
 * anything that came through it. It exists for the values that did NOT — rows
 * written by `app/api/register/route.ts`, which stores the handle exactly as
 * signed and predates this module.
 */
export function handleKey(handle: string): string {
  return handle.toLowerCase();
}

/**
 * May this player link this handle right now?
 *
 * Reject by default, per AGENTS.md rule 2 — every branch is an explicit
 * accept, and anything unrecognised falls through to a refusal.
 */
export function mayLinkHandle(args: {
  raw: string;
  /** What this player's row already holds. */
  current: string | null;
  /** True when ANOTHER player already holds the same key. */
  takenByAnother: boolean;
}): TurboHandleCheck {
  const parsed = normaliseHandle(args.raw);
  if (!parsed.ok) return parsed;

  if (args.current !== null && args.current.length > 0) {
    // Re-submitting the handle you already hold is a no-op, not an error: a
    // double-tap must not read as a failure.
    if (handleKey(args.current) === handleKey(parsed.handle)) return parsed;
    return { ok: false, reason: "already_linked" };
  }
  if (args.takenByAnother) return { ok: false, reason: "taken" };
  return parsed;
}

/** What to tell the player, in the language they are playing in. */
export function explainLinkRefusal(
  reason: TurboLinkRefusal,
  lang: "es" | "en",
): string {
  const ES: Record<TurboLinkRefusal, string> = {
    empty: "Escribe tu usuario de TURBO.",
    too_long: `Un usuario tiene como máximo ${TURBO_HANDLE_MAX} caracteres.`,
    bad_characters: "Solo letras, números, guiones y guiones bajos.",
    already_linked:
      "Esta cartera ya tiene un usuario vinculado. Escríbenos para cambiarlo.",
    taken: "Otra cartera ya vinculó ese usuario.",
  };
  const EN: Record<TurboLinkRefusal, string> = {
    empty: "Type your TURBO handle.",
    too_long: `A handle is at most ${TURBO_HANDLE_MAX} characters.`,
    bad_characters: "Letters, numbers, hyphens and underscores only.",
    already_linked:
      "This wallet already has a handle linked. Contact us to change it.",
    taken: "Another wallet has already linked that handle.",
  };
  return lang === "es" ? ES[reason] : EN[reason];
}
