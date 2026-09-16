import { recoverTypedDataAddress } from "viem";
import { autonomyTypedData } from "./typedData";

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
// The grant is SIGNED, and the signature is re-checked on every read rather than
// only when it is stored. That distinction is the whole security property:
// verifying at write time alone would still leave database write access
// sufficient to flip the mode and have the legitimate server trade on an
// attacker's behalf inside the hunter's leash. Re-verifying on read means a
// forged row fails to recover to the hunter's wallet and simply reads as "off".
//
// What it still is not: anchored. The Cota it names is on chain; this grant is
// not, so its existence is not independently timestamped. Non-repudiation comes
// from the signature, not from the chain, and nothing should claim more.

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

/**
 * Read a STORED grant, verifying the hunter actually signed it.
 *
 * Every failure is the same answer — "off" — and that is deliberate. A caller
 * deciding whether an agent may act does not need to know whether the signature
 * was forged, the row was half-written, the grant lapsed, or the mode was
 * garbage; it needs to know it may not act. Reasons are returned alongside for
 * logging, never for control flow.
 *
 * Checks, in the order they can fail cheaply:
 *   - the mode parses to a real grant
 *   - the grant has not expired on its own clock
 *   - every field the signature covers is present
 *   - the signature recovers to the hunter's own wallet
 */
export async function verifyStoredGrant(args: {
  stored: string | null | undefined;
  cotaDigest: string;
  signature: string | null;
  nonce: string | null;
  notAfter: Date | null;
  walletAddress: string;
  nowMs?: number;
}): Promise<{ mode: AutonomyMode; reason?: string }> {
  const mode = parseAutonomy(args.stored);
  if (mode === "off") return { mode: "off", reason: "no_grant" };

  const now = args.nowMs ?? Date.now();
  if (!args.notAfter || args.notAfter.getTime() <= now) {
    return { mode: "off", reason: "expired" };
  }
  if (!args.signature || !args.nonce) {
    return { mode: "off", reason: "unsigned" };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(args.cotaDigest)) {
    return { mode: "off", reason: "bad_digest" };
  }

  let recovered: string;
  try {
    recovered = await recoverTypedDataAddress({
      ...autonomyTypedData({
        cotaDigest: args.cotaDigest as `0x${string}`,
        mode,
        notAfter: BigInt(Math.floor(args.notAfter.getTime() / 1000)),
        nonce: args.nonce,
      }),
      signature: args.signature as `0x${string}`,
    });
  } catch {
    return { mode: "off", reason: "unrecoverable" };
  }

  if (recovered.toLowerCase() !== args.walletAddress.toLowerCase()) {
    return { mode: "off", reason: "wrong_signer" };
  }
  return { mode };
}

/** Is this a mode a hunter may set? Used to validate input. */
export function isAutonomyMode(v: unknown): v is AutonomyMode {
  return (
    typeof v === "string" && (AUTONOMY_MODES as readonly string[]).includes(v)
  );
}
