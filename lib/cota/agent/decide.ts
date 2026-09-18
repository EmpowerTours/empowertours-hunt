// What the agent does on one leash, decided without touching a socket.
//
// Every input arrives as data and every output is a description of an action, so
// the whole decision is testable without a venue, a database or a clock. The
// route that runs this does the reading and the sending; nothing here does I/O.
// That split is the point: this is the part that must be right, and a function
// you can hand a position to and ask "what now" is the only version of it
// anybody can check.
//
// ## The order of the checks is the safety argument
//
// Permission, then exit, then entry. Closing is considered BEFORE opening and
// the two are never both returned, because an agent that opens while a position
// it should have closed is still on the book is an agent that compounds a
// mistake it had already detected.
//
// ## Opening only from FLAT
//
// The agent may open only when it holds nothing. This is stricter than the leash
// requires — the notional ceiling would happily permit adding — and it is
// deliberate. The exit policy never closes at a loss, by instruction. An agent
// that may also ADD to a losing position has no state from which it must
// eventually act: it buys more, holds, buys more. Requiring flat means every
// position it opens is one it has to see through to a profitable exit before it
// can do anything else, which is the only thing that makes "never close at a
// loss" a policy rather than a ratchet.

import { agentMay, evaluationMode, type AutonomyMode } from "../autonomy";
import { shouldExit, type ExitPolicy, type PositionSnapshot } from "../exit";

export interface AgentInputs {
  mode: AutonomyMode;
  /** Null when the venue reports nothing open on this market. */
  position: PositionSnapshot | null;
  /** The price a close would fill at, or null if the book gave no side. */
  exitPriceUsd: number | null;
  /** Whether the leash would allow an open of the size being considered. */
  mayOpenNow: boolean;
  policy?: ExitPolicy;
}

export type AgentPlan =
  | { act: "nothing"; why: string }
  | { act: "close"; why: "take_profit"; netUsd: number; netBps: number }
  | { act: "open"; why: "flat_and_permitted" };

/**
 * One decision for one leash.
 *
 * Returns "nothing" for every condition it cannot act on, with a reason meant
 * for a log rather than for branching. A caller should never inspect `why` to
 * decide what to do next — if it needs to, this function is missing a case.
 */
export function decide(input: AgentInputs): AgentPlan {
  if (input.mode === "off") return { act: "nothing", why: "no_grant" };

  // observe reasons as full would, and the CALLER refuses to send. Narrowing
  // permissions here instead would make the log show what a restricted agent
  // would have done, which is a worse basis for the decision the hunter is
  // about to make on the strength of it.
  const mode = evaluationMode(input.mode);

  const holding =
    input.position !== null && Math.abs(input.position.signedSize) > 0;

  if (holding) {
    if (!agentMay(mode, "close")) {
      return { act: "nothing", why: "grant_forbids_close" };
    }
    // No exit price means the book gave us no side to sell into. Refuse rather
    // than fall back to the mark: the mark is the number that makes a losing
    // close look profitable.
    if (input.exitPriceUsd === null) {
      return { act: "nothing", why: "no_exit_price" };
    }
    const d = shouldExit(
      { ...input.position!, exitPriceUsd: input.exitPriceUsd },
      input.policy,
    );
    if (d.act === "close") {
      return {
        act: "close",
        why: "take_profit",
        netUsd: d.math.netUsd,
        netBps: d.math.netBps,
      };
    }
    // Holding a position that is not yet profitable enough. This is the state
    // the agent spends most of its life in, and it is not an error.
    return { act: "nothing", why: "holding" };
  }

  if (!agentMay(mode, "open")) {
    return { act: "nothing", why: "grant_forbids_open" };
  }
  if (!input.mayOpenNow) return { act: "nothing", why: "leash_refuses_open" };
  return { act: "open", why: "flat_and_permitted" };
}
