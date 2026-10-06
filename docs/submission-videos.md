# The two videos — shot lists and scripts

Deadline 13 Oct 21:59 CST. Both are required deliverables for every track.

Judging weights, which decide what these videos are _for_:

|                            |        |
| -------------------------- | ------ |
| Founder & Market Readiness | **25** |
| Technical Execution        | 20     |
| Design & Craft             | 20     |
| Traction & Path Forward    | **20** |
| Originality                | 15     |

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

## The one idea the demo has to land

Everything else is context for this: **software refusing an instruction because
of a number its owner signed, where neither the owner nor the operator can
override it.** Anyone can show a chart. Nobody else at this hackathon is
showing a machine saying no.

Open on a human so a judge cares, spend the middle on the refusal so they
remember, close on the loop so it reads as a product rather than a trick.

## If someone is filming with you

A second person is worth more than any amount of editing, for one reason: it
turns "the founder narrating his own screen" into "a stranger using it." That
is the Traction and Founder score, which is 45 of 100, and it cannot be
narrated into existence.

Give them these jobs, in order of value:

1. **Be the new user, on camera.** Their hands, their face unlocking a wallet
   they have never had before. No seed phrase, no extension, no app install.
   This is the single most valuable shot available and it cannot be faked.
2. **Hold the second phone** for the world shot — you walking, the drop
   appearing, a thumb hitting COLLECT outdoors. Ten to fifteen seconds, no
   more.
3. **Put you in frame for the pitch video.** A face talking to camera outscores
   a voice over slides, and you cannot hold the phone and be in shot.

**Ask permission before filming anyone, and say where it is going.** This is a
public submission. If they would rather not be identifiable, shoot hands only —
it loses nothing, because the point is the gesture, not the person.

# Video 1 — technical demo, 3:00

**Rewritten 2026-10-06.** The 24 Sep version told you to fill a leash form with
market, leverage, size and daily loss on camera. That form is gone: `/cota` now
renders `OneClickPanel` — "Put my MON to work", a percentage row, and a
long/short pair. The bound is still signed and still anchored, but the press
generates it rather than you typing it (`DEFAULT_LEASH` in
`lib/cota/oneclick-steps.ts`). Shooting the old script would film a screen that
no longer exists.

Screen recording of a phone, real account, real money. No slides at any point.

### 0:00–0:20 — a stranger, a face, a wallet

Not your screen. Someone else's hands.

> "She has never owned crypto. No seed phrase, no extension, nothing to
> install."

They tap, use their face, and the wallet exists. Let the silence do the work —
do not talk over the biometric prompt.

### 0:20–0:40 — it pays, on foot and on mainnet

Radar, a drop, the walk, COLLECT. Real MON, Monad mainnet.

> "She walks to a point on a map and gets paid in real MON. That is the
> onboarding — it asks for nothing she does not have."

If you have the Monad Open footage, use it here: she claimed an NFT at a kiosk,
sent it to the wallet her face had just made, and it is in her wallet now.

> "This arrived from an event kiosk. Same wallet, no import, no seed phrase."

### 0:40–1:05 — one press, four things

Open on `/cota`, signed in, with a real MON balance. The panel says "How much
of your MON?" above 5 / 30 / 80 buttons.

> "This is Cota. One press turns MON you earned on foot into a position on a
> perps venue — and it signs the limits that press can never exceed."

Tap **30%**. Let the "One press will:" list sit on screen for two seconds —
that list is the architecture, in the product's own words.

### 1:05–1:30 — the press, and what it actually does

Press **Put my MON to work**. One Face ID. Then narrate over the live steps as
they tick:

> "Four things, one signature. It sells MON for AUSD on Kuru's order book. It
> deposits to Perpl. It signs the leash as EIP-712 typed data and anchors it on
> Monad. Then it opens the position."

Let the anchor hash be visible for two seconds.

> "The wallet is a passkey — Face ID, no seed phrase, no extension, no install.
> The key that trades is derived from the passkey's PRF, so those four steps
> cost one prompt, not four."

### 1:30–2:10 — the refusal (the longest beat on purpose)

**This is still the most important shot in the video.** Go to `/judge` and open
**"Read what the leash actually refused."**

> "Here is the part I care about. Ask for more than the bound and it never
> reaches the venue."

Show the refusal and its reason — `notional_exceeded`, `leverage_exceeded` or
`trade_count_exceeded`, from `lib/cota/enforce.ts`.

> "That check is a pure function. No clock, no database, no network, and it
> fails closed. And the trading key can open and close but cannot withdraw —
> Perpl enforces that, not us. A fully compromised agent is still bounded to
> what I signed."

### 2:10–2:35 — the money is real and it came from another chain

Cut to `/cota/onramp`. The address is permanent.

> "Funding works from any chain. This address doesn't expire, and I sent USDC
> from Base to it."

Show the arrivals list with both rows — departure and arrival.

> "Base to Monad through Aurora Intents, and it lands as MON, so a new user can
> pay their own gas the moment they arrive. That was a dead end we found and
> closed."

### 2:35–2:50 — the loop

Back to `/cota`, then one beat on Hunt.

> "The MON funding all of this is earned on foot. Players walk to real GPS
> points in Mexico and get paid on Monad mainnet. Hunt earns you a wallet and a
> balance; Cota is where you put it to work under a leash you control."

### 2:50–3:00 — the honest close

Do not oversell. One true sentence:

> "It's live on mainnet today. Everything you just saw is production, and
> this wallet has moved about four thousand nine hundred MON through it."

### Shots to get before you start

- The percentage row with 30% selected, and the "One press will:" list
- The single Face ID prompt firing
- The anchor tx hash on screen
- **The refusal and its reason** — get this twice, it is the whole video
- `/cota/onramp` arrivals list showing the two rows
- The position appearing after the press

### Do NOT say

- **That Chainlink CRE drives the agent.** It was never deployed — deploy access
  is gated behind Early Access. `cre/agent-scheduler/` is built and _simulated_.
  The judge page was corrected once already for claiming otherwise; do not put
  it back in a video.
- **That anything works offline.** It does not. There is no service worker.
- Any player count you have not counted today.

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

> "Where it actually is: live on Monad mainnet, one funded trading account, and
> about four thousand nine hundred MON moved through it. Real players in Mexico,
> and now Thailand and Singapore, because the thing travels with me. Small, and
> every number is real."

### 1:45–2:00 — the path forward

> "Next is The Trading Festival in Mexico City in November, in a room with
> traders and prop firms — which is exactly the audience for a rulebook nobody
> can bend."

## Numbers — verified, and the ones only you can verify

Checked 2026-10-06 against production, safe to say out loud:

- **4,927 MON moved** by the trading wallet in the TOKEN2049 contest window
  (`GET /api/cota/mon-moved`, one wallet, `complete: true`). Chain-derived.
- **Nine bounties** are claimed on `/judge`, each with its own step.
- Live on Monad mainnet, chain 143.

**Do not say these until you have checked them on the day** — I could not:

- Any player or hunter count. Nobody has counted it this week.
- "The Trading Festival in Mexico City in November." Confirm it is still on and
  that you are going, or cut the line. A judge who knows the event and finds it
  moved has just learned to discount everything else you said.
- Total MON paid out to players. Different number from MON moved, and not
  measured here.

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
