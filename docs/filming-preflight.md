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

## Ready to paste

Creation **forces** `active: false` and `spawnEnabled: false` — activation is
its own audited edit — so this is two steps, not one. And `spawnEnabled` with
a zero budget is rejected outright, so the budget goes in at step 1.

Log in at `/admin`, open the browser console on that page, and paste. It is a
same-origin fetch on the `SameSite=Strict` session cookie; there is no token to
copy.

**Step 1 — create it.** Prints the new hunt id.

```js
await fetch("/api/admin/hunts", {
  method: "POST",
  headers: { "content-type": "application/json" },
  credentials: "same-origin",
  body: JSON.stringify({
    name: "Venue — TOKEN2049",
    description: "Indoor demo hunt. Short spawn radius, loose GPS gate.",
    // Drops land INSIDE the building. Default is 80-600m, which is the street.
    spawnMinRadiusM: 30,
    spawnMaxRadiusM: 60,
    unsurveyedSpawnRadiusM: 60,
    // Indoors a phone reports far worse than the +-33m it gives on a street.
    // At the 40m gate, check-in refuses and NOTHING spawns.
    maxAccuracyM: 80,
    // A demo queue, not a day's walking.
    spawnTtlSeconds: 600,
    spawnCooldownSeconds: 120,
    spawnMinMon: "0.0005",
    spawnMaxMon: "0.0015",
    // Required: spawnEnabled is refused while this is 0.
    budgetMon: "5",
    // THE IMPORTANT ONE. The player-facing hunt list has NO geo filter: every
    // active, unexpired hunt is offered to every hunter on earth. Without an
    // end date this farmable hunt sits in the Mexico players' list forever.
    // Set it to the hour the conference ends; the list filters on endsAt.
    endsAt: "2026-10-08T12:00:00Z",
    // Caps what one person can take in a day. Enforced in the collect route,
    // and only when above 0.
    spawnDailyCapMonPerPlayer: "0.05",
  }),
}).then((r) => r.json());
```

**Step 2 — switch it on.** Replace `HUNT_ID` with the id step 1 printed.

```js
await fetch("/api/admin/hunts/HUNT_ID", {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  credentials: "same-origin",
  body: JSON.stringify({ active: true, spawnEnabled: true }),
}).then((r) => r.json());
```

Why these numbers: `spawnMinRadiusM` 30 against a 25 m claim radius leaves a
~5 m walk — enough that the drop is not already collectable from the chair you
are sitting in, short enough to stay in one room. 60 m keeps it in the
building. Both are checked: `spawnMinRadiusM < spawnMaxRadiusM` is enforced and
equal values are rejected.

Auto-approval is forced to 0 at creation, so payouts queue for a human. Leave
it that way for a venue hunt full of strangers.

## How hunters find it, and how you stop it

**Hunters choose.** They browse `/hunt`, pick one, and play at
`/hunt/<huntId>`. Nothing is automatic and nothing is assigned. Spawns are
per-hunt — being in one hunt never grants another's drops.

**But the list is not geo-filtered.** `GET /api/hunts` returns every hunt with
`active: true` that has not passed its `endsAt`, ordered by start date, to
anyone who asks. There is no distance test. So a venue hunt with a 60 m spawn
radius and an 80 m accuracy gate appears in the list of every hunter in
Guerrero, and it can be farmed from a chair anywhere on earth.

Three things keep that bounded, and you want all three:

1. **`endsAt`** — the list filters on it, so the hunt retires itself. This is
   the control that works even if you forget.
2. **`budgetMon: "5"`** — the hard ceiling on total loss.
3. **`spawnDailyCapMonPerPlayer`** — caps one person's daily take. Enforced in
   the collect route's SQL, and only when above 0.

Auto-approval is forced to 0 at creation, so payouts queue for a human. You can
simply not approve anything that looks farmed.

### Turning it off

```js
await fetch("/api/admin/hunts/HUNT_ID", {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  credentials: "same-origin",
  body: JSON.stringify({ active: false, spawnEnabled: false }),
}).then((r) => r.json());
```

`active: false` takes effect immediately — `lib/hunt/spawn.ts` checks it on
every spawn and denies with `hunt_not_active`. It also drops out of the browse
list. Already-granted spawns expire on their own TTL.

**Know what you are trading away.** The annulus is an anti-spoofing control —
it is what stops someone collecting from a chair. A venue hunt with a 60 m
radius and an 80 m accuracy gate can be farmed by anyone in the building, and
that is an acceptable price for a demo and a bad one for the hunt that pays
real MON in Guerrero. Two hunts, different settings, and never confuse them.
