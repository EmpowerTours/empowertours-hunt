# Deploying empowertours-hunt

First run, from an empty Railway project to a live URL and a first surveyed zone.

Every minimum length below is **enforced in code and fails closed** — a short or
unset secret disables the feature rather than weakening it. A half-configured
deployment refuses to work instead of quietly running without auth.

---

## 1. Provision

- **Railway service** from `github.com/EmpowerTours/empowertours-hunt`.
- **Railway Postgres plugin** — it exposes `DATABASE_URL`, which is what
  `prisma/schema.prisma` reads.
- **Upstash Redis** database, for rate limiting.
- **Privy application** — you need the app id and the app secret.

## 2. Environment

Generate every secret with `openssl rand -hex 32`. Copy this block into Railway's
variable editor and fill it in. (There's no `.env.example` in the repo — this is
it.)

```bash
# --- Data stores (required) ---
DATABASE_URL=postgresql://user:password@host:5432/railway
UPSTASH_REDIS_REST_URL=https://example.upstash.io
UPSTASH_REDIS_REST_TOKEN=

# --- Player auth (required) ---
NEXT_PUBLIC_PRIVY_APP_ID=
PRIVY_APP_SECRET=
AUTH_SESSION_SECRET=          # MIN 32 CHARS
AUTH_PROVIDERS=mera,privy     # optional; valid values: mera, privy

# --- Admin auth (required to reach /admin) ---
ADMIN_SESSION_SECRET=         # MIN 32 CHARS
ADMIN_BOOTSTRAP_ADDRESS=0x    # your wallet; remove after first login

# --- Money (handle with care) ---
HUNT_TREASURY_PRIVATE_KEY=    # hot wallet, sends real MON
HUNT_TREASURY_ADDRESS=        # optional; derived from the key when unset
MONAD_RPC_URL=https://rpc.monad.xyz    # optional
PAYOUT_RECEIPT_TIMEOUT_MS=120000       # optional, default 120000

# --- Game secrets (required for the mechanics) ---
SPAWN_SEED_SECRET=            # unset = NO SPAWNS, route answers 503
HINT_GRID_SECRET=             # unsalted hints are a cache-location oracle

# --- Keeper (required for payouts to leave the queue) ---
CRON_SECRET=                  # MIN 16 CHARS; must match the GitHub secret

# --- Origins ---
NEXT_PUBLIC_APP_URL=https://hunt.empowertours.xyz   # no trailing slash
ALLOWED_ORIGINS=              # optional; authoritative when set
NEXT_PUBLIC_IPFS_GATEWAY=     # optional; has a default
```

### Notes on the ones that bite

| Variable | Why it matters |
|---|---|
| `AUTH_SESSION_SECRET` | Under 32 chars, no session can be minted **or** verified. Fails closed both ways. |
| `ADMIN_SESSION_SECRET` | Unset disables admin auth entirely — nobody can log in. |
| `ADMIN_BOOTSTRAP_ADDRESS` | Promotes exactly one wallet to OWNER so there's a way into a fresh database. It is a **standing grant, not a one-time coupon** — remove it once a real owner exists. |
| `SPAWN_SEED_SECRET` | Spawn seeds are `HMAC-SHA256(secret, spawnId)`. Unset means the route 503s rather than draw money from a predictable source. **Changing it invalidates the reveal for existing spawns.** |
| `CRON_SECRET` | Under 16 chars, `/api/cron/*` refuse to run. Must match `secrets.CRON_SECRET` in GitHub. |
| `HUNT_TREASURY_PRIVATE_KEY` | Signs real MON with no human in the loop once a payout is APPROVED. See §5. |
| `AUTH_PROVIDERS` | The outage knob. If mera's preview API breaks the browser half, set this to `privy` and logins keep working with no redeploy. |

## 3. Migrate

```bash
npx prisma migrate deploy
```

This is the **first** migration — there were none before — so it creates the
whole schema: 17 tables and 6 enum types, not just the recent additions. It was
generated with `migrate diff` rather than `migrate dev`, so it needs no shadow
database.

## 4. Keeper

Railway has **no cron**. Its `railway.json` schema has no `cron` array; entries
added there are silently ignored, nothing errors, and the payout queue simply
stops draining with no signal anywhere. `.github/workflows/keeper.yml` is the
only thing driving it.

**The schedule ships disabled.** Before there is a deployment to call, the
workflow's own configuration guard fails every tick — roughly 288 red runs and
288 failure emails a day, all saying the same thing. So the `schedule:` block in
`.github/workflows/keeper.yml` is commented out until you get here.

Turn it on in this order:

1. In the GitHub repo set:
   - `vars.HUNT_URL` — e.g. `https://hunt.empowertours.xyz`, no trailing slash
   - `secrets.CRON_SECRET` — identical to the deployment's value
2. Run the workflow manually (`workflow_dispatch`) and confirm it is green.
   A red manual run means the config is wrong; fix it before step 3.
3. Uncomment the `schedule:` block in `.github/workflows/keeper.yml` and push.

Until step 3 the payout queue does not drain on its own — nothing sweeps it but
a manual dispatch. Do not leave a funded, live deployment sitting at step 2.

Once scheduled, it sweeps approved payouts every 5 minutes and reconciles
ambiguous sends every 15. A `409` from the sweep is deliberate: an unresolved
payout halted it and needs a human.

## 5. Fund the treasury — small, and test it

`HUNT_TREASURY_PRIVATE_KEY` is a hot wallet on Monad mainnet.

1. Fund it with **one week's budget, never a treasury**.
2. Trigger the keeper manually (`workflow_dispatch`) and push **one small payout**
   all the way through to `SENT`.
3. Confirm the transaction on the explorer before trusting the path.

The payout module documents two prior double-pay bugs and the state machine that
fixed them; it is careful code, but no amount of care substitutes for watching
one real transaction land.

## 6. First login and first hunt

1. Visit `/admin/login` and sign in with `ADMIN_BOOTSTRAP_ADDRESS`.
2. **Remove `ADMIN_BOOTSTRAP_ADDRESS` and redeploy.**
3. Create a hunt at `/admin/hunts`.
4. Set its spawn bounds and budget on the hunt detail page.

## 7. Survey the walkable ground — this is the part only you can do

Nothing spawns until this is done. A hunt with no active `INCLUDE` zone places
no spawns at all; that is the intended failure direction, not a bug.

Go to **`/admin/hunts/<id>/zones`** on a phone, in the village, and walk it:

1. Trace the **hull** — the streets and plazas where it's safe to send someone.
   Drop a corner at each turn, standing still until the fix settles.
2. Trace **exclusions** for the river, the highway, private land.
3. **Leave a margin.** Fixes are accepted down to 60m accuracy. Trace the hull a
   few paces *inside* the safe edge and hazards a few paces *outside* them.
   Being generous costs nothing; being exact sends somebody to the riverbank.

The tool refuses a self-intersecting outline, anything under 200 m² (inside GPS
error), and anything over 25 km² (a stray corner left at the last location).

Then survey the caches themselves at `/admin/survey` and enter them in the cache
manager.

## 8. Before you tell anyone about it

- [ ] One real payout confirmed on the explorer
- [ ] `ADMIN_BOOTSTRAP_ADDRESS` removed
- [ ] At least one active `INCLUDE` zone
- [ ] Keeper green in GitHub Actions, and its `schedule:` block uncommented
- [ ] Walked to one spawn and collected it yourself

---

## What is still untested

The 370 tests in `npm test` are all **pure-function** tests — validator,
geometry, wei, the payout state machine. They prove the logic.

`npm run test:integration` adds 37 tests against a real Postgres, covering what
a pure function cannot: the migration applying, `schema.prisma` not having
drifted from it, the Json column round-tripping, every atomic ceiling holding
under genuine concurrency, and the two money routes taking their shared rows in
the same lock order — the last of which is invisible to any test that exercises
one route at a time.

```bash
docker run -d --name hunt-pg -e POSTGRES_PASSWORD=hunt -e POSTGRES_USER=hunt \
  -e POSTGRES_DB=hunt -p 5434:5432 postgres:16-alpine
export DATABASE_URL="postgresql://hunt:hunt@localhost:5434/hunt"
npx prisma migrate deploy
npm run test:integration
```

It is deliberately NOT in `.claude/verify.sh`: that gate has to run anywhere,
and this needs a database. Run it before any change to a route that spends.

Still untested by anything: a real browser, a real GPS receiver, and a real
transaction. Steps 5 and 8 are what convert those.
