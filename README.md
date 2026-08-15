# empowertours-hunt

A free-roam GPS collection game that feeds the TURBO cohort. Players walk to
real-world locations; the server decides whether they were actually there.

## Two economies, deliberately different

| | Cache finds | Spawns |
|---|---|---|
| Pays | **TURBO credit** (WMON-wei) | **native MON** (~0.001) |
| Withdrawable | No — a discount on a subscription | Yes |
| Location | Hidden, never sent to a client | **Public by design**, visible on radar |
| Lifetime | Permanent | Ephemeral, expires |
| Defence | Secrecy + quantized hints | Movement plausibility |

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
  Scale 0 means the database itself rejects `"0.5"`, `"1e18"` and `"0x10"`.
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

# Player auth: Mera passkey primary, Privy fallback, behind one interface.
AUTH_PROVIDER=mera
NEXT_PUBLIC_PRIVY_APP_ID=
PRIVY_APP_SECRET=

# Bearer for /api/cron/*. Routes refuse to run if unset.
CRON_SECRET=

NEXT_PUBLIC_TURBO_COHORT_ADDRESS=0xEae06514a0d3daf610cC0778B27f387018521Ab5
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
  `TurboCohort` `0xEae06514a0d3daf610cC0778B27f387018521Ab5`, TOURS
  `0x45b76a127167fD7FC7Ed264ad490144300eCfcBF`, both Monad mainnet.
