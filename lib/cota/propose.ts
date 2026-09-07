// ---------------------------------------------------------------------------
// Kimi trade proposer — a SUGGESTION engine bounded by the leash.
//
// Kimi never has authority. It reads the market and the player's signed limits
// and PROPOSES at most one order; then lib/cota/enforce.ts::mayOpen — pure,
// deterministic, tested — decides whether that proposal is inside the bound.
// A proposal that breaks the leash comes back with decision.ok === false and
// cannot execute, no matter how confident the model was. This is the house
// rule made literal: prefer a function to a model, and the verifier is the
// product; the model only fills the one slot a function cannot.
//
// SERVER ONLY: reads MOONSHOT_API_KEY. Never import into a client bundle.
// ---------------------------------------------------------------------------

import { z } from "zod";
import {
  mayOpen,
  type Decision,
  type DayState,
  type EnforcedBound,
  type ProposedOrder,
} from "./enforce";
import { fromLeverageX100, fromUsdE6, leverageX100, usdE6 } from "./scale";

const MOONSHOT_BASE = "https://api.moonshot.ai/v1";
// Tracks the current Kimi quickstart (platform.kimi.ai). Override with
// MOONSHOT_MODEL if a given key exposes a different model string.
const DEFAULT_MODEL = "kimi-k3";

/** One market's state, the context Kimi reasons over. */
export interface MarketSnapshot {
  market: string;
  priceUsd: number;
  change24hPct?: number;
  fundingRatePct?: number;
}

export interface ProposeInput {
  bound: EnforcedBound;
  state: DayState;
  markets: MarketSnapshot[];
  nowSeconds: bigint;
}

/** Injectable for tests; defaults hit the real Kimi API. */
export interface ProposeDeps {
  fetch?: typeof fetch;
  apiKey?: string;
  model?: string;
}

// What Kimi must return, in human units. Validated strictly — a proposal we
// cannot parse is a failure, not a trade.
const ProposalSchema = z.object({
  action: z.enum(["open", "hold"]),
  market: z.string().max(32).optional(),
  side: z.enum(["long", "short"]).optional(),
  notionalUsd: z.number().nonnegative().finite().optional(),
  leverage: z.number().positive().finite().optional(),
  rationale: z.string().max(600),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export interface ProposalResult {
  /** What Kimi suggested, verbatim after validation. */
  proposal: Proposal;
  /** The scaled order, or null when Kimi chose to hold. */
  order: ProposedOrder | null;
  /** The authority. Only order !== null && decision.ok may execute. */
  decision: Decision;
}

/** Infrastructure failure — no key, API error, unparseable reply. NOT a denial. */
export class ProposerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposerError";
  }
}

function systemPrompt(bound: EnforcedBound, state: DayState): string {
  const headroom = bound.maxNotionalUsdE6 - state.openNotionalUsdE6;
  const lossLeft = bound.maxDailyLossUsdE6 - state.lossTodayUsdE6;
  const tradesLeft = Math.max(0, bound.maxTradesPerDay - state.tradesToday);
  return [
    "You are a disciplined perpetual-futures trading assistant operating under a",
    "signed, non-negotiable risk leash. You may propose AT MOST ONE order, or hold.",
    "",
    "HARD LIMITS (a proposal outside any of these will be rejected by code — do not",
    "propose one):",
    `- venue: ${bound.venue}`,
    `- allowed markets: ${bound.markets.length ? bound.markets.join(", ") : "(none — you must hold)"}`,
    `- max leverage: ${fromLeverageX100(bound.maxLeverageX100)}x`,
    `- max TOTAL open notional: $${fromUsdE6(bound.maxNotionalUsdE6)}`,
    `- currently open notional: $${fromUsdE6(state.openNotionalUsdE6)} (headroom $${fromUsdE6(headroom < 0n ? 0n : headroom)})`,
    `- trades left today: ${tradesLeft}`,
    `- loss budget left today: $${fromUsdE6(lossLeft < 0n ? 0n : lossLeft)}`,
    "",
    "If no trade is a good risk-adjusted opportunity within these limits, return",
    'action "hold". Prefer holding over a marginal trade.',
    "",
    "Respond with ONLY a JSON object of this exact shape:",
    '{"action":"open"|"hold","market":string,"side":"long"|"short",',
    '"notionalUsd":number,"leverage":number,"rationale":string}',
    'For a hold, set action="hold" and omit the order fields; still give a rationale.',
  ].join("\n");
}

function userPrompt(markets: MarketSnapshot[]): string {
  return [
    "Current market snapshot:",
    JSON.stringify(markets),
    "",
    "Propose one order within the limits, or hold.",
  ].join("\n");
}

/**
 * Ask Kimi for a proposal and gate it against the leash.
 *
 * Throws {@link ProposerError} on infrastructure failure (no key, API error,
 * unparseable reply) — those are not trading denials and must not be confused
 * with one. A well-formed proposal always returns, with `decision` as the final
 * word on whether it may execute.
 */
export async function proposeOrder(
  input: ProposeInput,
  deps: ProposeDeps = {},
): Promise<ProposalResult> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const apiKey = deps.apiKey ?? process.env.MOONSHOT_API_KEY;
  const model = deps.model ?? process.env.MOONSHOT_MODEL ?? DEFAULT_MODEL;
  if (!apiKey) throw new ProposerError("MOONSHOT_API_KEY is not set");

  const res = await doFetch(`${MOONSHOT_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt(input.bound, input.state) },
        { role: "user", content: userPrompt(input.markets) },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ProposerError(`Kimi API ${res.status}: ${body.slice(0, 200)}`);
  }

  let data: { choices?: { message?: { content?: string } }[] };
  try {
    data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
  } catch {
    throw new ProposerError("Kimi response body was not JSON");
  }
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new ProposerError("Kimi returned no content");

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new ProposerError("Kimi reply was not valid JSON");
  }
  const parsed = ProposalSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProposerError(
      `Kimi reply failed schema: ${parsed.error.message}`,
    );
  }
  const proposal = parsed.data;

  if (proposal.action === "hold") {
    return { proposal, order: null, decision: { ok: true } };
  }

  if (
    !proposal.market ||
    proposal.notionalUsd == null ||
    proposal.leverage == null
  ) {
    throw new ProposerError('Kimi "open" proposal is missing order fields');
  }

  // Snap to the signing grid before scaling: the model returns arbitrary
  // precision, but usdE6/leverageX100 reject anything off-grid, and that is a
  // representation detail, not a policy denial.
  let order: ProposedOrder;
  try {
    order = {
      venue: input.bound.venue,
      market: proposal.market,
      notionalUsdE6: usdE6(
        Math.round(proposal.notionalUsd * 100) / 100,
        "notional",
      ),
      leverageX100: leverageX100(
        Math.round(proposal.leverage * 100) / 100,
        "leverage",
      ),
    };
  } catch (e) {
    throw new ProposerError(
      `proposal not representable: ${(e as Error).message}`,
    );
  }

  const decision = mayOpen(input.bound, input.state, order, input.nowSeconds);
  return { proposal, order, decision };
}
