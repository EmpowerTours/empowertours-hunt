# empowertours-hunt

A free-roam GPS collection game that feeds the TURBO cohort. Players walk to
real-world locations; the server decides whether they were actually there.

## Two economies, deliberately different

|              | Cache finds                       | Spawns                                 |
| ------------ | --------------------------------- | -------------------------------------- |
| Pays         | **TURBO credit** (WMON-wei)       | **native MON** (~0.001)                |
| Withdrawable | No — a discount on a subscription | Yes                                    |
| Location     | Hidden, never sent to a client    | **Public by design**, visible on radar |
| Lifetime     | Permanent                         | Ephemeral, expires                     |
| Defence      | Secrecy + quantized hints         | Movement plausibility                  |

Credit is denominated in WMON-wei so it is directly comparable to
`TurboCohort.tierPrice` — roughly 139 WMON is one month of Explorer. Because a
find issues a discount rather than cash, acquisition cost becomes a number you
can read off rather than guess at, and it only converts to real spend when
someone actually joins the cohort.

Spawns are the only path in the system where money leaves the treasury. Every
bound on them is enforced as an atomic database invariant.

`TOURS` is intended as the consumable layer — lures, hints, re-rolls — which
gives the token the sink it currently lacks. Not built yet.

## Architecture

The verifier is the product. `lib/hunt/validator.ts` is a **pure function**: no
DB, no network, no clock. The route supplies the facts, it decides. That is what
makes every rejection reproducible from a stored row, and it is why a payout
dispute is answered by replaying `ClaimAttempt` rows rather than by anyone
guessing. It rejects by default — every path that is not an explicit accept
returns a reason code.

```
app/api/hunt/[huntId]/claim    -> validateClaim -> Find + CreditLedger  (atomic)
app/api/hunt/[huntId]/hint     -> proximityHint -> {band, remaining}    (no coords)
app/api/hunt/[huntId]/spawn    -> spawn engine  -> Spawn                (CSPRNG)
        .../spawn/collect      -> validateClaim -> Payout PENDING       (atomic)
app/api/cron/payouts           -> sendApprovedPayout                    (human-gated)
app/api/cron/reconcile         -> resolve SENDING against the chain
```

## Security properties this codebase is trying to hold

These are load-bearing. A refactor that breaks one is a money bug, not a style
regression. See `AGENTS.md` for the full rules.

- **Cache coordinates never reach a client.** Not in a body, not in an error,
  not in a reject `detail`. The hint endpoint returns a quantized band only.
- **Reject by default.** Comparisons are written so a `NaN` falls into the
  reject branch, not through it.
- **Ceilings are atomic.** Every budget, cap and counter is a conditional
  `UPDATE ... WHERE current + delta <= ceiling` with a checked row count, inside
  the transaction it bounds. A read-then-write is a bug even when it looks right.
- **Wei is `Decimal(78,0)` in Postgres and `bigint` in code.** Never a `number`.
  The column type is NOT the guard, and this used to say it was. Measured
  against Postgres 16, `numeric(78,0)` silently COERCES rather than rejects:
  `'0.5'` becomes `1`, `'1e18'` becomes a whole MON, `'0x10'` becomes `16`, and
  `'-1'` is accepted outright. Scale 0 controls rounding, not admission, and
  there are no CHECK constraints. `lib/wei.ts` is the entire guard —
  `tests/integration/schema.itest.ts` pins both halves.
- **Nothing irreversible is unbounded.** Sending MON is gated by a per-payout
  cap, a per-player rolling 24h cap, a per-hunt budget, and an approval policy.
  A flagged attempt never auto-approves.
- **Once broadcast, never auto-retried.** A payout that may have hit the mempool
  goes to `NEEDS_RECONCILIATION` and is resolved by asking the chain about
  `(treasury, nonce)` — never by sending again.

## Environment

Create `.env` (git-ignored) with:

```
DATABASE_URL=postgresql://user:pass@host:5432/hunt?schema=public

# Monad mainnet is chain id 143. Override the public RPC — payout reliability
# depends on it; a slow RPC is what turns a broadcast into an ambiguous outcome.
MONAD_RPC_URL=https://rpc.monad.xyz

# Bounded hot wallet. NOT the deployer key — reusing deploy authority would put
# the whole ecosystem behind a GPS check.
HUNT_TREASURY_PRIVATE_KEY=

# HMAC key for spawn commit-reveal. The spawn seed is derived rather than
# stored, so rotating this invalidates the reveal for any live spawn. Spawn
# routes refuse to serve (503) without it.
SPAWN_SEED_SECRET=

# Optional. How long to wait for a payout receipt before the row becomes
# NEEDS_RECONCILIATION. Default 120000.
PAYOUT_RECEIPT_TIMEOUT_MS=120000

# Rate limits and single-use nonces. REQUIRED in production — the in-memory
# nonce store cannot prevent replay across instances, so the store refuses to
# build without these rather than silently degrading.
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# Session signing. Required, >= 32 chars. No session is minted or verified
# without it.
AUTH_SESSION_SECRET=

# Optional. Comma-separated origin allowlist for the mutating-request check in
# proxy.ts. Without it the check falls back to trusting the Host header.
ALLOWED_ORIGINS=

# Optional. Offsets the hint-snapping lattice so it is unpredictable to someone
# who has read the source. Snapping still defeats averaging without it.
HINT_GRID_SECRET=

# Player auth: Mera passkey. The wallet IS the passkey, so there is no
# second provider — see lib/auth/index.ts resolveWallet.

# Bearer for /api/cron/*. Routes refuse to run if unset.
CRON_SECRET=

NEXT_PUBLIC_TURBO_COHORT_ADDRESS=0x13a63A60b0E0104911e845a7e944646045C1558F
NEXT_PUBLIC_TOURS_TOKEN_ADDRESS=0x45b76a127167fD7FC7Ed264ad490144300eCfcBF
```

## Development

```bash
npm install
npm run db:generate
npm run db:push
npm run dev

npm test          # vitest — pure logic, no DB required
npm run typecheck
```

## Deployment

Railway + Upstash Redis. **`railway.json` has no `cron` support** — entries
there are silently ignored and never fire. The payout keeper and reconciler must
be driven by `.github/workflows/keeper.yml` hitting `/api/cron/*` with
`CRON_SECRET`.

## Related

- `~/projects/turbo-empowertours` — the cohort this funnels into.
  `TurboCohort` `0x13a63A60b0E0104911e845a7e944646045C1558F`, TOURS
  `0x45b76a127167fD7FC7Ed264ad490144300eCfcBF`, both Monad mainnet.

## Hackathon submission notes

Metropolis (1 Sep – 13 Oct 2026). This section exists because §4.1 of the
rules requires it, and everything in it is checkable against `git log`.

### Pre-existing components (§4.1.4)

This repository was **not** started during the Hackathon period. Its first
commit is 2026-08-15, seventeen days before the window opened. Fourteen commits
predate 1 September and are the foundation the submission builds on:

- the GPS claim verifier (`lib/hunt/validator.ts`) and its accuracy, clock-skew
  and movement-plausibility rules;
- the spawn commit-reveal draw and walkable-area placement (`lib/hunt/spawn.ts`);
- the two-economy model — TURBO credit for cache finds, native MON for spawns;
- the payout state machine, the treasury send queue and the keeper workflow;
- the Prisma schema, the integration suite, and `.claude/verify.sh`.

`git log --until=2026-08-31` lists them exactly.

### Built during the window (144 commits since 1 September)

- **Cota** — an EIP-712 bound a hunter signs before software may trade for
  them. One enforcement path (`lib/cota/enforce.ts`) governs paper and live
  execution alike, with a bilingual read-back before signing, an HTTP seam a
  Python trading agent calls before every order (`app/api/cota/check`), and the
  signed bound anchored on Monad.
- **The executor** — the half that makes the bound more than a promise:
  server-held venue keys under AES-256-GCM (`lib/cota/keystore.ts`), the Perpl
  wire protocol held to captured golden frames (`lib/cota/venue/frames.ts` and
  its conformance suite), and a single order path in which the gate runs
  _before_ the transport — no code path reaches the venue without passing
  `mayOpen`.

  **It trades.** Account 5273 holds a real position opened by this code, and the
  ledger reconciles with the venue to the microdollar. Getting there meant
  finding four separate causes behind one symptom — "Accepted (not filled yet)"
  — and each is worth recording because three were ours.

  `fw: false` was the first. An earlier revision of this section said it was
  "not fixable from here" and that the question was open with the venue. **That
  was wrong.** Perpl's "1-click trading" is not a venue-side setting: it is
  `allowOrderForwarding(bool)`, an on-chain call from the account holder's own
  wallet (selector `0x7962f910`, confirmed in the live implementation behind the
  exchange proxy). So it was always a transaction this application could send,
  and it now sends it as the third signature of the deposit flow — no hunter
  meets that wall again.

  The rest were ours. `rq` is the order's on-chain `orderDescId` and must
  strictly exceed the account's last; this client sent a literal `1` every time,
  so the first order forwarded and every later one was silently discarded. Fills
  landing after the placing socket closed were never recorded, so the ledger
  disagreed with the venue forever and every subsequent order refused. And the
  trades-per-day ceiling had never bound at all — it counted distinct order ids
  taken from a field that was always `1`.

- **An agent that acts unattended, inside two signatures.** The hunter signs the
  Cota (how much) and separately signs an autonomy grant (whether, unsupervised
  — `off`, `exit_only`, or `full`). The grant is EIP-712, scoped to one leash by
  digest, and **re-verified on every read**, so database write access alone
  cannot make an agent act. The exit policy (`lib/cota/exit.ts`) is a function
  rather than a model: it closes only on a net gain after fees already paid, the
  fee to close, and the spread crossed on exit — and never at a loss, by
  instruction. `decide()` does no I/O, so what the agent will do is testable
  without a venue.
- **A daily-loss stop that refuses to guess**, and a correction to what this
  document previously claimed. It said Perpl's position frames "carry no entry
  price and no PnL". They carry `ep`, plus a Q16 residue in `epr`. The earlier
  claim traced to a set of keys another client happened to parse, not to a
  survey of what the venue sends, and the probe built to settle it was never run
  against an open position. Loss is still gated on the fill ledger reconciling
  with the venue — in both size and entry price — and returns _null_ rather than
  zero when it cannot be vouched for, because a limit that silently disables
  itself is worse than no limit.
- **A close path**, which is the half of a leash that existed only in a comment.
  `enforce.ts` had always said reducing "stays permitted always"; nothing could
  reduce anything, so a hunter could enter a position through this app and had
  no way out of it. `mayReduce` is gated on no ceiling, no expiry and no
  revocation — every one of those, applied to a reduce, turns a safety limit
  into a trap.
- **A Chainlink CRE workflow** as the agent's scheduler (`cre/agent-scheduler`),
  built and simulated. Every node in a DON executes an HTTP request, so a naive
  POST would be one agent run per node; a server-side lease makes exactly one
  win per leash.
- **A risk screen** that leads with what a close would actually realise rather
  than unrealised PnL against the mark — about 30 bps apart on MON, which is the
  width of the band where a position reads green and pays out red. It shows no
  liquidation price, and says on screen why: the venue documents its two margin
  fractions in contradictory units.
- **A second secret from the same passkey.** Mera's PRF under a different salt
  yields an AES-256-GCM key, imported non-extractable, that never leaves the
  page — so a hunter's private note on a leash is stored as ciphertext this
  server cannot read. Not "will not": there is no key here to hold.
- **Check-in** — a verified position without a planted cache, which is what
  makes the game playable anywhere rather than only where somebody has hidden
  something.
- **Sembradores** — player-created hunts and caches, with a signed rights
  warranty and a cache kill switch.
- **TURBO credit redemption**, the public hunt endpoints, the heading-up
  compass and bearing pointer, OSM zone import, surveyor attribution, and
  instant payout on collect.

### What does not work yet (§4.1)

Stated because a submission that only lists what works is not a report.

- **A new hunter cannot onboard.** Perpl requires 10 AUSD to open an account and
  the MON→AUSD desk holds 3.35. AUSD is the illiquid leg on Monad: MON/USDC on
  Kuru is ~$18k deep at zero fees, MON/AUSD is ~$5, AUSD/USDC is ~$0.13. Nothing
  on-chain converts MON into AUSD at a useful size, so the desk is a manual
  subsidy rather than an on-ramp.
- **Everything is proven on one account.** 5273 is the only account this code has
  ever traded. Anything that only breaks on a second hunter's state is untested.
- **The agent has no measured edge.** It has been verified to stay inside its
  bound, never to make money. The claim this project makes is about the bound.

### Use of AI coding tools (§4.1.4)

**Disclosed: the substantial majority of the code in this repository was
written with Anthropic's Claude, via Claude Code, in an interactive pairing
session.** Design decisions, product direction, safety trade-offs and every
merge were the author's. The commit messages are unusually long by
convention — they record why a decision was made, not just what changed.

### Monad integration (§9.2)

- Chain: **Monad mainnet, chain id 143**. Payouts are native MON transfers
  broadcast from a bounded hot treasury.
- Live payout treasury: `0xea8B552737FC6cD433646544AEC9bC6d12a9Fa0b`
- Perpl (perpetuals venue Cota bounds): instance
  `0x34b6552d57a35a1d042ccae1951bd1c370112a6f`, collateral AUSD
  `0x00000000efe302beaa2b3e6e1b18d08d69a9012a`
- **Why Monad specifically:** the payout path is a per-collection native
  transfer. Sub-second blocks are what make "walk there, get paid" a few
  seconds rather than a few minutes. Two Monad-specific behaviours are handled
  explicitly and documented in code: gas is charged on the gas LIMIT rather
  than gas used (`lib/hunt/payout.ts`), and EIP-7702 delegated accounts reserve
  10 MON that cannot be spent.

### Ownership and licence

Copyright © 2026 **EmpowerTours**. Every commit in this repository is authored
by EmpowerTours, and authorship and copyright stay with EmpowerTours.

The code is released under the **MIT Licence** (see `LICENSE`). That is not a
transfer of ownership — MIT keeps the copyright with the holder and grants
others permission to use, copy and modify the work, on the condition that the
copyright notice travels with it. Anyone reusing this code must carry the
EmpowerTours notice.

An OSI licence is not optional here: Metropolis §7.2 requires submissions to be
open source under MIT, Apache 2.0, GPL or BSD, and to stay publicly accessible
during and after the Hackathon. So the choice was which permissive licence to
use, not whether to publish. MIT keeps the attribution requirement while asking
the least of anyone building on it.

The **EmpowerTours** name and marks are not licensed by MIT and remain
EmpowerTours' own.

### External code

Next.js, React, Prisma, viem, next-intl, zod, Upstash Redis, Vitest — all under
their own licences. Walkable-area data is imported from **OpenStreetMap**
(© OpenStreetMap contributors, ODbL) via the Overpass API; see
`scripts/import-osm-zones.mjs`.

### Verifying this yourself

```bash
npm install
./.claude/verify.sh   # typecheck, lint, 957 tests, production build, secret scan
```
