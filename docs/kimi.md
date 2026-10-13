# The model proposes, the function decides: Kimi inside Cota

Cota lets someone trade perpetuals on Perpl (Monad) inside limits they sign once: an EIP-712 "bound" naming the market, max leverage, max position size, a daily loss ceiling and an expiry. We use Kimi for exactly one job: proposing an entry.

## Why a model, and why only there
Most of a trading agent should not be a model. Whether an order fits the user's limits is a yes/no question, so it lives in `lib/cota/enforce.ts::mayOpen`, a pure function with no clock, network or database that fails closed. Exits are mechanical too (`lib/cota/exit.ts`): a take-profit that an LLM re-argues every five minutes is not a take-profit. The one slot a function can't fill well is "given this market, is anything worth opening?" That is Kimi's job.

## How it's wired
`lib/cota/propose.ts` (server only) sends Kimi (`kimi-k2.6` through the Moonshot API) the market snapshot: price, 24h change, funding, and recent closes, along with the user's signed bound and today's state. Kimi returns at most one order as JSON, which we validate with zod. We snap it to the signing grid, then pass it to `mayOpen`. If Kimi proposes something outside the bound, the decision comes back `ok: false` and the order never reaches Perpl, however confident the model was.

Early on we sent the model a single spot price and asked it to prefer holding. It held every time, which was correct, because one number is not a market. Adding recent closes gave it something to reason about.

## What we learned
- Ask the API, not the docs: `GET /v1/models` on our key listed `kimi-k2.7-code` and `kimi-k2.6`. An earlier default model name could never have worked.
- Some models accept only temperature 1, so read the error message.
- If the model is down, that's a reason to hold, not an error. The agent logs `proposer_unavailable` and does nothing.

## The record
Every decision is public at hunt.empowertours.xyz/judge/record: 2,040 decisions, 17 orders, 7 fills on Perpl, and 3 refusals, including a DOGE order refused because the user never named that market. The model proposes, and the user's signature decides.
```

