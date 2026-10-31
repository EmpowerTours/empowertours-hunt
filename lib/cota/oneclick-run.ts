// ---------------------------------------------------------------------------
// Carrying out a one-click plan, one step at a time, reporting exactly where it
// stopped.
//
// Three of the four steps move money and none of them can be rolled back. A
// swap that lands and a deposit that then reverts leaves the hunter holding
// AUSD at an address they did not choose to hold it at — recoverable, but only
// if they are TOLD. So this returns the outcome of every step attempted, and a
// failure names the last one that succeeded. Nothing here swallows an error to
// keep a button looking tidy.
//
// The steps are injected rather than imported, so the sequencing can be tested
// without a chain. The real callers pass the functions from swap.ts and
// deposit.ts; a test passes ones that fail on cue. This is the part worth
// testing — each individual call is already covered where it lives, and what
// has never been exercised is what happens when the second of four fails.
//
// THE SWAP GOES THROUGH KURU'S ORDER BOOK, NOT THE ORACLE DESK.
//
// Both can turn MON into AUSD and the desk is one call rather than two, so the
// desk is the easier thing to reach for. It is still the wrong one here:
//
//   * the book is where the Kuru bounty is, and it is the venue this project
//     already proved on mainnet (0x1453ee16…6fef)
//   * a swap through Kuru writes a KuruSwap row, which is what the MON-moved
//     leaderboard counts. A desk swap is invisible to it
//   * it is a real market price rather than one desk's quote
//
// The old worry was depth. It does not survive contact with the live book: on
// 2026-10-04 the top bid alone was 5,871 MON ($199.60), with $498 and $4,987
// behind it, so the ~293 MON that Perpl's $10 floor demands clears inside the
// first level with no price impact. The "~$5 deep" figure that argued for the
// desk was the MON/AUSD book, not the MON/USDC one this actually trades.
//
// planOnboarding() in kuru.ts does it in two legs — MON to USDC on the book,
// then USDC to AUSD — and reports throughOrderBook so the claim can be checked
// rather than asserted.
//
// ONE PASSKEY UNLOCK COVERS THE WHOLE SEQUENCE. The account is a viem
// LocalAccount derived from the passkey PRF, so it signs every transaction
// without prompting again. That is what makes one click honest rather than one
// click and three more taps.
// ---------------------------------------------------------------------------

import type { Step } from "./oneclick";

export interface StepOutcome {
  step: Step;
  ok: boolean;
  /** Transaction hash, where the step produced one. */
  hash?: string;
  /** Present only on failure, already turned into a sentence for the hunter. */
  error?: string;
  /**
   * True only when the step failed before sending any transaction, so nothing
   * moved. Read off the error's own `nothingSent` (see SwapNotStarted in
   * kuru-swap.ts); absent means unknown, never "nothing happened".
   */
  nothingSent?: boolean;
}

export interface RunResult {
  /** True only when every step in the plan succeeded. */
  ok: boolean;
  outcomes: StepOutcome[];
  /**
   * The step that failed, if one did.
   *
   * Named so the screen can say "the swap went through, the deposit did not"
   * rather than "something went wrong", which on a path that has already spent
   * the hunter's money is not an acceptable thing to say.
   */
  failedAt: Step | null;
}

export interface Runners {
  swap: () => Promise<string>;
  deposit: () => Promise<string>;
  leash: () => Promise<string>;
  trade: () => Promise<string>;
}

/**
 * Run the plan in order, stopping at the first failure.
 *
 * Stopping rather than continuing is deliberate: the later steps assume the
 * earlier ones landed, and a deposit attempted after a failed swap would fail
 * too, costing another gas limit on Monad — where the whole limit is charged
 * whether the call succeeds or not — to tell the hunter something already known.
 */
export async function runPlan(
  steps: readonly Step[],
  runners: Runners,
  explain: (step: Step, err: unknown) => string,
): Promise<RunResult> {
  const outcomes: StepOutcome[] = [];

  for (const step of steps) {
    try {
      const hash = await runners[step]();
      outcomes.push({ step, ok: true, hash });
    } catch (err) {
      const nothingSent =
        (err as { nothingSent?: unknown } | null)?.nothingSent === true;
      outcomes.push({
        step,
        ok: false,
        error: explain(step, err),
        ...(nothingSent ? { nothingSent } : {}),
      });
      return { ok: false, outcomes, failedAt: step };
    }
  }

  return { ok: true, outcomes, failedAt: null };
}

/**
 * What the hunter still holds after a partial run, in words.
 *
 * A failure in the middle is not a clean "nothing happened", and saying so is
 * the whole reason the outcomes are kept. Each sentence names where the money
 * actually is, so the next screen they open is the right one.
 */
export function strandedAfter(
  result: RunResult,
  lang: "es" | "en",
): string | null {
  if (result.ok || result.failedAt === null) return null;
  const es = lang === "es";
  const done = new Set(result.outcomes.filter((o) => o.ok).map((o) => o.step));

  if (result.failedAt === "deposit" && done.has("swap")) {
    return es
      ? "El cambio sí se hizo: tienes AUSD en tu cartera. Lo que falló fue el depósito en Perpl — tu dinero está a salvo, vuelve a intentar el depósito."
      : "The swap did go through, so you are holding AUSD in your wallet. It was the deposit to Perpl that failed — your money is safe, try the deposit again.";
  }
  const failed = result.outcomes.find((o) => !o.ok);
  if (result.failedAt === "swap" && failed?.nothingSent) {
    // Known, not guessed: the swap stopped before its first transaction was
    // sent. Saying "your MON may have been sold" here sent a hunter to the
    // USDC screen on 2026-10-30 after Kuru's API timed out with nothing signed.
    return es
      ? "No se envió nada: tu MON sigue intacto y no se cobró gas. Puedes intentar de nuevo más tarde, o cambiar en la pantalla de Cambiar."
      : "Nothing was sent: your MON is untouched and no gas was charged. You can try again later, or use the Swap screen.";
  }
  if (result.failedAt === "swap") {
    // The swap is now one desk transaction: it pays its quote or reverts, so
    // the MON is untouched either way. (The two-leg Kuru route it replaced
    // could leave USDC behind; that is why this used to hedge.) What is not
    // known from here is whether a reverted attempt cost gas, so it says so.
    return es
      ? "El cambio no se hizo: tu MON sigue en tu cartera. Si la transacción llegó a la cadena y se revirtió, se cobró el gas."
      : "The swap did not go through: your MON is still in your wallet. If the transaction reached the chain and reverted, its gas was charged.";
  }
  if (result.failedAt === "leash" || result.failedAt === "trade") {
    return es
      ? "Tu dinero ya está depositado en Perpl y sigue siendo tuyo. Lo único que falta es firmar la correa y abrir la operación."
      : "Your money is already deposited at Perpl and still yours. All that is left is signing the leash and opening the trade.";
  }
  return null;
}
