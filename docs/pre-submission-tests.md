# Pre-submission: trying to break it

Do not record a demo of software nobody has attacked. This is what has been
tried, what held, and what only a human with a phone can check.

## Already run — adversarial pass on the live API, 2026-09-24

Against `cota.empowertours.xyz`, production.

### The auth boundary held

| Probe                                         | Result                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `GET /api/cota/aurora` unauthenticated        | **401**                                                                                     |
| `POST /api/cota/aurora` unauthenticated       | **403**                                                                                     |
| `GET /api/cota/zerion` unauthenticated        | **401**                                                                                     |
| `GET /api/cota/aurora/tokens` unauthenticated | 200 — public by design, carries no key and names nobody                                     |
| Path traversal, null bytes, 2000-char params  | 401 — **auth is checked before parameters**, so hostile input is never parsed by a stranger |

### Nobody can read anyone else's data

This was the one that mattered, because both routes take a wallet somewhere.

| Probe                                                                                       | Result                                                                         |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /api/cota/zerion?wallet=<victim>&address=<victim>` **while signed in as someone else** | `{"holdings":[]}` — the _caller's_ own empty wallet. Params ignored.           |
| `POST /api/cota/aurora` with forged `recipient`, `sender`, `playerId` in the body           | Issued an address with `recipient` = **the caller's** wallet. Forgery ignored. |

Both hold for the same reason: the wallet comes from the session and is not a
parameter, so there is nothing to forge.

### Input validation

| Probe                            | Result                                          |
| -------------------------------- | ----------------------------------------------- |
| `?depositChain=notachain`        | 400 `bad_chain`                                 |
| `?destinationAsset=USDT0`        | 400 `bad_asset`                                 |
| `POST {destinationAsset:"PEPE"}` | 400 `bad_request`                               |
| `POST {depositChain:"solana"}`   | 400 `bad_request` — `sol` is the valid spelling |

### Two soft spots, neither blocking

1. **`?type=everything` returned 200, not 400.** The route returns early when
   the hunter has no address row, before the `type` parameter is validated. A
   caller with a row gets the 400; a caller without one does not. Harmless —
   nothing is read or written either way — but the route disagrees with itself
   about whether that input is valid.
2. **A malformed JSON body succeeds.** `POST` with `"not json"` issues an
   address, because the body parse falls back to `{}` and every field has a
   default. Idempotent and scoped to the caller's own wallet, so nothing is at
   risk — but a client bug sending garbage would never surface.

Both are worth fixing after 13 October, not before. Neither affects money,
neither affects another user, and changing them now means redeploying the thing
being filmed.

---

## Re-run 2026-10-06 — the app has changed a lot since 24 Sep

Against `cota.empowertours.xyz`, production. The September pass predates the
one-click rebuild, the Kuru routing, the agent schedule going live and the
leash revoke, so none of its results could be assumed to still hold.

### The auth boundary still holds, and is now wider

Every money route refuses before it reads anything:

| Route                                                                 | Unauthenticated                      |
| --------------------------------------------------------------------- | ------------------------------------ |
| `POST /api/cota/trade`, `/close`, `/revoke`, `/propose`, `/reconcile` | **403**                              |
| `POST /api/cota/agent/run`                                            | **403**                              |
| `GET /api/cota/account`, `/risk`, `/history`                          | **401**                              |
| `GET /api/cota/aurora`, `/zerion`                                     | **401**                              |
| `GET /api/cota/aurora/tokens`                                         | 200 — public by design, names nobody |

Path traversal, null bytes, a 2000-character parameter and a 4000-character
wallet all returned **401** — auth is still checked before parameters, so a
stranger's input is never parsed.

### One September soft spot is fixed

A malformed JSON body to `POST /api/cota/aurora` used to issue an address.
It now returns **403**: the origin guard refuses it before the body is read.
Tried with `not json`, `{"a":`, `[]` and `null`.

### One route is the exception to "the wallet comes from the session"

`GET /api/cota/spot-pnl?wallet=<any address>` answers **unauthenticated**, for
any wallet, with trade-by-trade realised P&L and transaction hashes. It
returns 400 rather than 401 because it validates the address before anything
else — there is no session to check.

**This is deliberate and documented in the route**: every figure under it is
already on a public chain, and a wallet owner reading their own books should
not need an account. Reasonable. But note what it costs: the September pass
concluded "the wallet comes from the session and is not a parameter, so there
is nothing to forge", and that sentence is no longer true app-wide. What the
endpoint adds over the chain is convenience — someone can enumerate wallets and
get a formatted P&L instantly instead of deriving it.

Decide before filming whether that is the intent. If it is, it is fine and
needs no change. If it is not, it is a one-line session check. Do not discover
the answer during a judge's walkthrough.

### Not retested

`?type=everything` returning 200 instead of 400 — the September note says that
only reproduces for a caller _without_ an address row, which needs a session to
set up. Still outstanding, still harmless.

---

## Still to test — needs a human with a phone

The automated pass cannot touch any of this. Every item is on the path a judge
will walk.

### The stateless test, on real hardware

Already proven with a virtual authenticator, **not** on a phone. Sign in on your
phone, clear the browser's site data mid-session, sign in again. The address
must be identical. If it is not, stop and do not ship.

### The path a judge takes, end to end

1. Open the live link on a phone you have never signed in on
2. Create a wallet with Face ID
3. `/cota/onramp` → get an address → confirm it says **MON**
4. Send a small amount from another chain
5. Watch it arrive in the arrivals list
6. `/cota` → pick a percentage → **Put my MON to work**
7. `/judge` → "Read what the leash actually refused"

**Steps 6 and 7 are not what the September list said**, which walked
`/cota/swap` then `/cota/deposit` as separate legs and then asked for a trade
outside the bound. One press now does the Kuru swap, the Perpl deposit, the
EIP-712 leash signature and anchor, and the trade. And because that press sizes
the leash for you, there is no longer an obvious way to exceed your own bound
from the panel — the refusal lives on `/judge`.

**Run the whole press with real money before filming, not during.** It is four
legs under one signature, and the only one ever exercised alone is the swap.

### Things to actively try to break

- Type a swap amount larger than your balance. Then one with letters in it.
  Then `0`. Then a number with fifteen decimal places.
- Set a leash with a daily loss of 0, or leverage of 0, and see what it says.
- Hit the swap button twice fast. Confirm it does not send two transactions.
- Turn the phone to airplane mode mid-swap, then back on. What does the screen
  claim happened?
- Open the app in a private window with no site data at all.
- Rotate to landscape on every `/cota` page.
- Let a session sit for an hour, then press a button — does it fail cleanly or
  silently do nothing?

### Both languages

Every screen in Spanish **and** English. The onramp, swap, leash and refusal
copy all changed in the last two days and only Spanish has been looked at on a
real screen.

### The judge's own login

Write the login instructions the submission asks for, then **follow them
yourself on a device you have never used**, exactly as written. Instructions
that assume something already on your phone are the most common way a working
product scores as broken.
