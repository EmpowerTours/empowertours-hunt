# The two videos — shot lists and scripts

Deadline 13 Oct 21:59 CST. Both are required deliverables for every track.

Judging weights, which decide what these videos are *for*:

| | |
|---|---|
| Founder & Market Readiness | **25** |
| Technical Execution | 20 |
| Design & Craft | 20 |
| Traction & Path Forward | **20** |
| Originality | 15 |

**45% of the score is the two things code cannot demonstrate.** The demo video
carries Technical Execution and Design; the pitch video carries Founder
Readiness and Traction. Shoot them as two different jobs.

## Rules that constrain the shoot

- Technical demo **≤3 min**, showing the **live product**. Explicitly not slides
  and not a code walkthrough. A screen recording of the real app.
- Pitch **≤2 min**: team, problem, why you.
- Judges get a live link and login instructions separately, so the video does
  not need to explain how to sign in.

## Language

**Narrate in English, leave the UI in Spanish.** Do not switch the app to
English for the camera. A judge seeing Spanish-first UI while hearing "our
players are in Guerrero" is the traction argument making itself. Add English
subtitles.

---

# Video 1 — technical demo, 3:00

Screen recording of a phone, real account, real money. No slides at any point.

### 0:00–0:20 — the thing that is actually different

Open on `/cota` already signed in. Say what the product is in one sentence
while the leash form is on screen:

> "This is Cota. Before any software trades for you, you sign the limits it can
> never exceed — the market, the leverage, the size, and how much you're willing
> to lose in a day."

Fill the form on camera. Real numbers, small ones.

### 0:20–0:45 — sign it, anchor it

Face ID. The signature happens.

> "That's a passkey — Face ID, no seed phrase, no extension, no app install.
> The wallet *is* the passkey. And the bound is now EIP-712 typed data, anchored
> on chain."

Show the anchor transaction. Let the hash be visible for two seconds.

### 0:45–1:15 — the refusal

**This is the most important shot in the video.** Ask the agent for a trade
outside the bound.

> "Now I'll ask it to trade bigger than my own limit."

Show the refusal, with the reason, in plain language.

> "It never reached the venue. The check is a pure function — no clock, no
> database, no network — and it fails closed. And the trading key can open and
> close positions but cannot withdraw. Perpl enforces that, not us. A fully
> compromised agent is still bounded to what I signed."

### 1:15–2:00 — the money is real and it came from another chain

Cut to `/cota/onramp`.

> "Funding works from any chain. This address is permanent, and yesterday I sent
> two dollars of USDC from Base to it."

Show the arrivals list with both rows — departure and arrival.

> "Fourteen seconds, Base to Monad, through Aurora Intents. It lands as MON, so
> a new user can pay their own gas the moment they arrive — that was a dead end
> we found and closed."

Show the balance panel. The numbers are real; say so.

### 2:00–2:35 — the leg that makes it collateral

Run the swap to AUSD on camera, live.

> "Perpl settles in AUSD, so this converts through Kuru's order book and a
> Uniswap v4 pool. Same wallet, same passkey."

Show the resulting AUSD balance.

### 2:35–3:00 — the loop, and the honest limit

Back to `/cota`.

> "The MON that funds all this is earned on foot — players walk to real GPS
> locations in Mexico and get paid on Monad mainnet. Hunt earns you a wallet and
> a balance; Cota is where you put it to work under a leash you control."

Close on one true sentence about the state of it. Do not oversell:

> "It's live on mainnet today, with a small number of real players and one
> funded trading account. Everything you just saw is production."

### Shots to get before you start

- The leash form with real numbers typed
- The Face ID prompt firing
- The anchor tx hash on screen
- **The refusal message** — get this twice, it is the whole video
- `/cota/onramp` arrivals list showing the two rows
- The swap completing and the AUSD balance changing

---

# Video 2 — pitch, 2:00

Face to camera. This one is about you, not the product.

### 0:00–0:25 — the problem, from where you actually stand

> "I'm in Tierra Colorada, Guerrero. The people I'm building for have never
> opened an exchange and never will. They don't have a broker, they don't have
> KYC documents on file anywhere, and nobody is going to hand them an account."

### 0:25–0:50 — what you built and why that shape

> "So the wallet is a face. One tap, no seed phrase, and they're holding real
> money on Monad — which they earn by walking to a GPS point and getting paid.
> That's the onboarding. It works because it doesn't ask for anything they don't
> have."

### 0:50–1:20 — the insight, stated as a belief

> "The second half is the part I care about. Everyone says AI agents will trade
> for us. Nobody says what stops one. Cota is a permission layer: you sign the
> limits, the check fails closed, and the key can't withdraw. A prop firm sells
> you that rulebook and enforces it with a dashboard they can change after a bad
> day. Mine is signed, on chain, and I can't bend it either."

### 1:20–1:45 — traction, stated honestly

Do not inflate this. Judges have seen a hundred inflated numbers today.

> "Where it actually is: live on Monad mainnet, a small group of real players in
> Mexico, one funded trading account, real payouts on chain. Small, and every
> number is real."

### 1:45–2:00 — the path forward

> "Next is The Trading Festival in Mexico City in November, in a room with
> traders and prop firms — which is exactly the audience for a rulebook nobody
> can bend."

## Tone notes

- Say the small numbers out loud. "One funded account" from someone who clearly
  built the whole thing reads as credible; a fabricated hockey stick reads as a
  fabricated hockey stick, and this judging panel will have seen both by lunch.
- Do not apologise for the scale. State it and move to why it will grow.
- No music over the pitch. Music over the demo is fine and quiet.

---

# Before either shoot — the bug hunt

Do not record a demo of software nobody has tried to break. The list lives in
`docs/pre-submission-tests.md`.
