// May the agent act with nobody watching, and how far.
//
// Every other gate in this system bounds SIZE — how much, how often, how much
// loss. This one bounds PRESENCE: whether an order may be sent at all when the
// hunter is not in the app. It is a different axis and deserves its own answer,
// because "I trust an agent to trade $20" and "I trust it to do so while I sleep"
// are separate statements and a hunter makes them separately.
//
// The grant is recorded on a Cota, not on a Player. What is being authorised is
// "act unattended up to THIS ceiling", so it is scoped by the bound it names:
// revoke the leash and autonomy dies with it, and signing a larger leash
// requires consenting again instead of inheriting permission for a ceiling
// nobody agreed to run unattended.
//
// It is NOT independently verifiable. The Cota is signed and anchored; this
// grant is a server-side record against it, set through an authenticated
// session. That is a real limitation and stating it here is cheaper than having
// someone infer a guarantee the system does not make.

/** Actions the agent can want to take without a hunter present. */
export type AgentAction = "open" | "close";

export const AUTONOMY_MODES = ["off", "exit_only", "full"] as const;
export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

/**
 * Read a stored value into a mode.
 *
 * Anything unrecognised — null, empty, a typo, a value written by an older or
 * newer build — reads as "off". This is the one place in this file that must
 * fail closed: an unreadable grant is not a grant, and defaulting the other way
 * would let a bad migration or a fat-fingered update authorise unattended
 * trading on every leash at once.
 */
export function parseAutonomy(stored: string | null | undefined): AutonomyMode {
  if (stored === "exit_only" || stored === "full") return stored;
  return "off";
}

/**
 * May the agent do this, unattended, under this grant?
 *
 *   off        nothing. The hunter's session is required, as it is today.
 *   exit_only  may CLOSE, may never OPEN.
 *   full       may do both.
 *
 * exit_only exists because it is the grant most people actually want and the
 * only one that cannot increase exposure: the worst an agent with it can do is
 * take a profit earlier than the hunter would have. Opening unattended is a
 * materially larger thing to authorise and should not ride in on the same
 * checkbox.
 *
 * Note what this does NOT decide: whether closing is a good idea, or whether the
 * order fits the leash. Those are exit.ts and enforce.ts, and both still run.
 * This answers only "is anyone allowed to be acting right now".
 */
export function agentMay(mode: AutonomyMode, action: AgentAction): boolean {
  if (mode === "full") return true;
  if (mode === "exit_only") return action === "close";
  return false;
}

/** Is this a mode a hunter may set? Used to validate input. */
export function isAutonomyMode(v: unknown): v is AutonomyMode {
  return (
    typeof v === "string" && (AUTONOMY_MODES as readonly string[]).includes(v)
  );
}
