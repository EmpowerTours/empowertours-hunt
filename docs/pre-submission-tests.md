# Pre-submission: trying to break it

Do not record a demo of software nobody has attacked. This is what has been
tried, what held, and what only a human with a phone can check.

## Already run — adversarial pass on the live API, 2026-09-24

Against `cota.empowertours.xyz`, production.

### The auth boundary held

| Probe | Result |
|---|---|
| `GET /api/cota/aurora` unauthenticated | **401** |
| `POST /api/cota/aurora` unauthenticated | **403** |
| `GET /api/cota/zerion` unauthenticated | **401** |
| `GET /api/cota/aurora/tokens` unauthenticated | 200 — public by design, carries no key and names nobody |
| Path traversal, null bytes, 2000-char params | 401 — **auth is checked before parameters**, so hostile input is never parsed by a stranger |

### Nobody can read anyone else's data

This was the one that mattered, because both routes take a wallet somewhere.

| Probe | Result |
|---|---|
| `GET /api/cota/zerion?wallet=<victim>&address=<victim>` **while signed in as someone else** | `{"holdings":[]}` — the *caller's* own empty wallet. Params ignored. |
| `POST /api/cota/aurora` with forged `recipient`, `sender`, `playerId` in the body | Issued an address with `recipient` = **the caller's** wallet. Forgery ignored. |

Both hold for the same reason: the wallet comes from the session and is not a
parameter, so there is nothing to forge.

### Input validation

| Probe | Result |
|---|---|
| `?depositChain=notachain` | 400 `bad_chain` |
| `?destinationAsset=USDT0` | 400 `bad_asset` |
| `POST {destinationAsset:"PEPE"}` | 400 `bad_request` |
| `POST {depositChain:"solana"}` | 400 `bad_request` — `sol` is the valid spelling |

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
6. `/cota/swap` → MON → AUSD
7. `/cota/deposit` → AUSD into Perpl
8. Sign a leash, ask for a trade outside it, see the refusal

**Step 7 is the only leg never run with real money.** The desk holds 103 AUSD.
Do it before filming, not during.

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
