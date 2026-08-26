# empowertours-hunt — build contracts

Read this before writing code. It exists so parallel work does not collide and
so the security properties below survive contact with a refactor.

## What this is

A free-roam GPS collection game feeding the TURBO cohort. Two economies:

- **Cache finds** pay **TURBO credit**, denominated in **WMON-wei**, non-withdrawable.
  A discount on a subscription, not cash. `CreditLedger` is the source of truth.
- **Spawns** pay **real native MON**, small (~0.001 MON), random, visible,
  ephemeral. This is the only path where money leaves the treasury.

`TOURS` is a future consumable (lures, hints, re-rolls). Not built yet — do not
add TOURS code without being asked.

## Hard rules

1. **Cache `lat`/`lng` never reach a client response.** Not in a body, not in an
   error, not in a reject `detail`. Spawn coordinates ARE public by design.
2. **Reject by default.** Any path that is not an explicit accept must return a
   rejection. Never write `if (bad) reject()` where a NaN slips through the
   comparison — use `if (!(good)) reject()`.
3. **Wei is `Decimal @db.Decimal(78, 0)`** in the DB and `bigint` in code. Never
   `number`, never `parseFloat`. Convert with the helpers in `lib/wei.ts`.
4. **Ceilings are atomic.** Every budget, cap or counter is enforced by a
   conditional `UPDATE ... WHERE current + delta <= ceiling` whose affected-row
   count is checked, inside the same transaction as the write it bounds. A
   read-then-write is a bug even if it looks correct.
5. **Ceilings lock `PlayerHunt` before `Hunt`.** Both money routes touch the
   per-player counter row and the hunt's single `Hunt` row; taken in opposite
   orders they deadlock, and neither route deadlocks against ITSELF, so load
   testing one route finds nothing. Measured: interleaved claims and collects
   killed ~0.7% of claims with an HTTP 500. `Hunt` goes last because every
   claim and every collect in the hunt contends on it, so the global lock is
   held for the shortest window. `tests/integration/lock-order.itest.ts` is the
   guard. A new ceiling touching both rows takes them in this order.
6. **Nothing irreversible happens without a bound.** Sending MON is gated by
   per-payout cap, per-player rolling 24h cap, per-hunt budget, and auto-approval
   policy. A flagged attempt never auto-approves.
7. **No secrets in code.** `HUNT_TREASURY_PRIVATE_KEY`, `PRIVY_APP_SECRET`,
   `UPSTASH_*` come from env. Never log them, never echo them.
8. **Do not weaken a control to make a test pass.** Fix the test.

## File ownership — do not edit outside your lane

| Lane | Owns |
|---|---|
| verifier | `lib/geo/**`, `lib/hunt/validator.ts`, `lib/hunt/proximity.ts`, `lib/hunt/credit.ts`, `app/api/hunt/[huntId]/claim/**`, `app/api/hunt/[huntId]/hint/**` |
| payout | `lib/hunt/payout.ts`, `lib/hunt/spawn.ts`, `lib/hunt/approval.ts`, `lib/wei.ts`, `app/api/hunt/[huntId]/spawn/**`, `app/api/cron/**` |
| auth | `lib/auth/**`, `lib/ratelimit.ts`, `proxy.ts`, `app/api/auth/**`, `app/api/register/**` |
| ui | `app/page.tsx`, `app/layout.tsx`, `app/globals.css`, `app/providers.tsx`, `app/hunt/**` (pages), `components/**`, `next.config.ts`, `postcss.config.mjs`, `app/manifest.ts` |
| admin | `app/admin/**`, `app/api/admin/**`, `lib/admin/**` |

Shared, owned by nobody — propose a change, do not just make one:
`prisma/schema.prisma`, `package.json`, `AGENTS.md`.

## Shared interfaces — implement/consume exactly these

### `lib/wei.ts` (payout lane provides)

```ts
import type { Prisma } from "@prisma/client";
/** Prisma Decimal -> bigint. Throws on a non-integer or negative value. */
export function toWei(d: Prisma.Decimal | string | number): bigint;
/** bigint -> string safe to hand Prisma for a Decimal(78,0) column. */
export function fromWei(v: bigint): string;
/** Human display, e.g. 1000000000000000n -> "0.001". */
export function formatMon(v: bigint, maxDecimals?: number): string;
/** Parse admin input. Rejects "1e18", "0x10", "", " 5 ", negatives, decimals beyond 18dp. */
export function parseMonInput(input: string): bigint;
```

### `lib/ratelimit.ts` (auth lane provides)

Backed by Upstash Redis when `UPSTASH_REDIS_REST_URL` is set, falling back to a
**bounded** in-memory limiter otherwise. The in-memory fallback must cap its map
size and must not push a timestamp for an already-blocked caller (that was an
O(n^2) CPU amplifier). Fail **closed** on a Redis error for money paths.

```ts
export type LimitName = "claim" | "hint" | "spawn" | "register" | "admin";
export interface LimitResult { ok: boolean; remaining: number; resetAt: number; }
/** Keyed on both playerId and ip; caller passes both. */
export function checkLimit(
  name: LimitName,
  key: { playerId?: string; ip: string },
): Promise<LimitResult>;
```

### `lib/auth/index.ts` (auth lane provides)

```ts
export class AuthError extends Error {}
export interface SessionPlayer { id: string; walletAddress: string; active: boolean; suspendedAt: Date | null; }
/** Throws AuthError. Never returns an anonymous-but-allowed caller. */
export function requirePlayer(req: Request): Promise<SessionPlayer>;
/** Verifies an EIP-712 signed claim. Returns the recovered lowercased address. */
export function verifySignedClaim(payload: SignedClaim): Promise<string>;
```

Player auth is **Mera passkey first, Privy fallback**, behind this interface so
neither leaks into a route. Admin auth is separate and never uses Mera.

## EIP-712 signed claims

Every claim and spawn collect is signed by the player's key. This makes attempts
non-repudiable, and removes the CSRF and stolen-cookie exposure of a bare
cookie session.

```
domain: { name: "EmpowerToursHunt", version: "1", chainId: 143 }
ClaimAttempt: { huntId: string, lat: string, lng: string, accuracyM: string,
                clientTs: uint256, nonce: string }
```

`nonce` is single-use, stored in Redis with a TTL matching the clock-skew
window. A replayed nonce is rejected.

## Environment

```
DATABASE_URL=
HUNT_TREASURY_PRIVATE_KEY=      # hot wallet, NEVER the deployer key
MONAD_RPC_URL=                  # override; do not hardcode the public endpoint
SPAWN_SEED_SECRET=              # REQUIRED. HMAC key for spawn commit-reveal.
                                # Rotating it breaks the reveal for live spawns.
                                # Both spawn routes 503 without it.
PAYOUT_RECEIPT_TIMEOUT_MS=      # optional, default 120000
HINT_GRID_SECRET=               # optional. Offsets the hint-snapping lattice.
                                # Snapping defeats averaging without it; the
                                # secret makes the lattice unpredictable to
                                # someone who has read the source.
UPSTASH_REDIS_REST_URL=         # REQUIRED in production: the in-memory nonce
UPSTASH_REDIS_REST_TOKEN=       # store cannot stop replay across instances,
                                # so the nonce store refuses to build without it
AUTH_SESSION_SECRET=            # REQUIRED, >= 32 chars. No session can be
                                # minted or verified without it.
AUTH_PROVIDERS=                 # optional, default "mera,privy"
ALLOWED_ORIGINS=                # optional but recommended; without it the
                                # origin check falls back to trusting Host
NEXT_PUBLIC_PRIVY_APP_ID=
PRIVY_APP_SECRET=
CRON_SECRET=                    # bearer for /api/cron/*
```

## Testing

`npm test` (vitest, `lib/**/*.test.ts`). Pure logic must be tested without a DB.
Every security fix gets a regression test that fails against the old behaviour.
Do not add a test that asserts a control is absent.

## Definition of done

`npm run typecheck` clean, `npm test` green, no `any` in new code, no secret in
a log line, and every control in "Hard rules" still holds.
