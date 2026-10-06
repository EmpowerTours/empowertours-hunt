# Pre-flight: the hour before you record

Run this in order. Every item is something that has actually gone wrong, or
that was measured today and will be false next week.

## 1. Top up MON, and know why

Checked 2026-10-06: wallet held **357.6 MON** at **$0.029239** = **$10.46**.
Perpl's deposit floor is **$10**. So every percentage button sold the same
345 MON — 97% of the wallet — because an ask under the floor is raised to it.

| wallet           | what 5% sells  | what 30% sells    |
| ---------------- | -------------- | ----------------- |
| 357 MON ($10)    | 345 MON (97%)  | 345 MON (97%)     |
| 1,200 MON ($35)  | 345 MON (29%)  | 350 MON (30%) ✓   |
| 8,000 MON ($234) | 400 MON (5%) ✓ | 2,400 MON (30%) ✓ |

**Target ~8,000 MON.** That is the point where all three buttons mean what
they say, with room for the price to move before you finish filming.
1,200 MON is the bare minimum for the 30% tap the script calls for, and leaves
5% still lying on camera.

Re-check the price before you commit — `GET /api/cota/markets` — because every
number above is a function of it.

## 2. Run the press once, privately, with real money

Not on camera. It is four legs under one signature — Kuru swap, Perpl deposit,
EIP-712 leash signed and anchored, trade opened — and only the swap leg has
ever been exercised alone.

Confirm after it lands:

- [ ] The swap step showed a MON figure, and it matched what left the wallet
- [ ] AUSD arrived at Perpl (balance moved from 0)
- [ ] An anchor transaction exists, and you can open it on MonadScan
- [ ] A position is open at the venue
- [ ] `/cota/risk` shows it

If any step fails, **do not film around it**. Fix it or cut that beat.

## 3. The refusal shot

`/judge` → "Read what the leash actually refused". Confirm it renders a real
refusal with a reason from `lib/cota/enforce.ts` — `notional_exceeded`,
`leverage_exceeded` or `trade_count_exceeded`. This is the most important
shot in the video; get it twice.

## 4. The phone itself

- [ ] **Sound toggle OFF** in the Hunt header, or the collect chime lands on
      top of your narration. Leave it on for exactly one deliberate collect if
      you want the beat, then mute.
- [ ] Do Not Disturb on. A WhatsApp banner mid-anchor is a reshoot.
- [ ] Battery above 60% — the GPS watch and the screen recorder together are
      not kind to it.
- [ ] Brightness up. Dark UI on a dim screen records as mud.
- [ ] Clear the notification shade.
- [ ] Hard refresh so you are on the current build, not a cached one.

## 5. Language

Narrate in English, **leave the UI in Spanish**. A judge hearing "our players
are in Guerrero" while reading Spanish-first UI is the traction argument
making itself. Do not switch the app for the camera.

## 6. The two cameras

- **Primary: screen recording on the hunting phone.** iOS built-in recorder.
  Judges have to be able to read a MON figure and a transaction hash.
- **Second phone: 10–15 seconds of the world** — walking, the drop appearing,
  a thumb hitting COLLECT outdoors. This is the only thing a screen recording
  cannot show, and it is what makes the product obviously physical.
- **Narration recorded separately, indoors, afterwards.** Outdoor phone audio
  is wind and traffic.

## 7. Things not to say

- **Not** that Chainlink CRE drives the agent. It was never deployed — access
  is gated behind Early Access. `cre/agent-scheduler/` is built and simulated.
- **Not** that anything works offline. There is no service worker. The app is
  installable, which is a different thing.
- **Not** any player count nobody has counted this week.
- **Not** the Mexico City festival in November unless you have confirmed it is
  still on and that you are going.

Safe to say, verified 2026-10-06: live on Monad mainnet (chain 143);
**4,927 MON moved** by the trading wallet this contest window, chain-derived
from `/api/cota/mon-moved`; nine bounties claimed on `/judge`.

---

# Filming indoors at a venue

The default hunt places drops in an annulus **80–600 m** from your verified
position, deliberately, so that collecting one always requires real movement.
At a conference that means walking out of the building.

**Do not shrink the live Mexico hunt to fix this.** Make a separate hunt.

The fields are on `/admin/hunts/<id>`, the same form as the accuracy gate:

| field                    | default | venue     |
| ------------------------ | ------- | --------- |
| `spawnMinRadiusM`        | 80      | **15**    |
| `spawnMaxRadiusM`        | 600     | **60**    |
| `unsurveyedSpawnRadiusM` | 300     | **60**    |
| `maxAccuracyM`           | 40      | **60–80** |

`radiusMeters` — how close you must get to collect, 25 m — **stays as it is**.
That is the one people mean when they say "claim radius", and making it
smaller would make claiming harder, not easier. What you want is the drop
appearing nearer, which is the spawn radius.

The accuracy gate needs raising too, and this is the part that bites: indoors,
under a roof and surrounded by steel, a phone reports far worse than the ±33 m
it gives you on a street. At ±40 m the check-in will refuse and nothing will
spawn at all.

**Know what you are trading away.** The annulus is an anti-spoofing control —
it is what stops someone collecting from a chair. A venue hunt with a 60 m
radius and an 80 m accuracy gate can be farmed by anyone in the building, and
that is an acceptable price for a demo and a bad one for the hunt that pays
real MON in Guerrero. Two hunts, different settings, and never confuse them.
