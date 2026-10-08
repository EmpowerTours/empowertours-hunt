# Metropolis submission — every field, ready to paste

Checklist was **1/6** with 5d 22h left when this was written (2026-10-08).
Primary track (Onchain Finance & Trading) is the only complete item.

Paste order matters: do the text fields first, then the two videos last, since
those are the only ones that cannot be done at a desk.

---

## PROJECT DETAILS

**Project name** — already filled (4 chars). Leave it.

**One-line description** — already filled (122/200). Leave it.

**Description** — already filled (2,579/8,000), and it is good. Source of truth
is `docs/submission-description.md`. **Re-read the numbers in it before you
save** — several are counts from production that move.

**GitHub repository** — `https://github.com/EmpowerTours/empowertours-hunt`
The LICENSE is proprietary, so it must be shared with
`metropolis@hackathon.monad.xyz` rather than made public. Do that in GitHub →
Settings → Collaborators before you submit, or the judges hit a 404.

**Live product** — `https://hunt.empowertours.xyz` (and `https://cota.empowertours.xyz`
for the trading side; the judge walkthrough is `https://hunt.empowertours.xyz/judge`).

---

## GO-TO-MARKET AND USER ACQUISITION _(0/8,000 — paste this)_

We do not acquire users, we pay them to arrive.

**The wedge is that the first touch costs the player nothing and earns them
something.** A hunter does not download an app, does not write down a seed
phrase, does not pass KYC and does not fund an account. They open a link,
touch the sensor on their phone, walk to a point on a map and are paid in real
MON on Monad mainnet. The cost of trying us is one walk. That is the entire
funnel, and it is why it works on people who have never opened an exchange.

**Distribution is physical and local, not an ad budget.** Caches are placed
along walkable corridors in Guerrero, Mexico. The product spreads the way a
street game spreads: somebody is visibly paid, in public, by their phone, and
the person next to them asks what that was. We have tested this directly at
events — onboarding strangers on their own phones, in under a minute, with no
prior crypto. Paid acquisition is closed to us anyway: X and TikTok both
refuse crypto advertising, so organic and physical were never optional.

**The second act is what makes a hunter worth more than a visit.** MON earned
on foot is a balance that does nothing. Cota is where it goes to work: the
hunter signs a bound and a strategy trades inside it. That turns a one-off
reward into a reason to come back, and it is the only part of the product with
revenue attached — we are a Perpl builder and take at most 2 bps of the volume
we route, disclosed inside the signature the user gives. We never hold funds.

**Why Guerrero first and not a crypto audience.** Crypto-native users already
have wallets, exchanges and opinions; they are the most contested and least
loyal audience in the market. People who have never had an account have no
incumbent to leave. They also have the sharpest version of the problem: no
broker will open an account for them, and nobody is going to. Serving that
first produces a product that works everywhere, because a design that assumes
nothing works for people who have everything too.

**Then the artists.** Hunters spend MON on music licences from real artists —
90% of a primary sale goes to the artist, settled on Monad. Each artist brings
their own audience, which is the second acquisition channel and the one that
compounds: the musician has a reason to tell people, because they get paid
when those people arrive.

**Where it goes next.** The near term is more corridors in Mexico and more
artists in the catalogue. The medium term is the prop-trading audience, who
understand immediately what a bound nobody can override is worth — a prop firm
sells you a rulebook and enforces it with a dashboard they can change after a
bad day; ours is signed, anchored on chain, and we cannot bend it either.

---

## JUDGE ACCESS INSTRUCTIONS _(optional, but paste it)_

Start at **https://hunt.empowertours.xyz/judge** — an eleven-step walkthrough,
each step linking the exact code or transaction behind it.

**Eight of the eleven steps work on an empty wallet**, including the one that
matters: "Read what the leash actually refused" shows a real refusal from the
live agent, with the reason, written by the executor rather than staged.

Only anchoring, swapping and trading need funds. If you want to run those,
create a wallet with your phone's passkey (no seed phrase, no extension) and
tell us the address — we will fund it.

Two honest notes so nothing surprises you:

- The Chainlink CRE workflow in `cre/agent-scheduler/` is **built and
  simulated, not deployed**. Deployment is gated behind Early Access, which we
  do not have. `SIMULATION.md` is a real run of `cre workflow simulate`, which
  makes a real HTTPS call, but it is not a DON deployment and we do not claim
  it is.
- Creating a wallet on **Android** requires a passkey provider that supports
  the PRF extension, which in practice means Google Password Manager. We lost
  a real onboarding to an account whose GPM vault had never been unlocked.
  Nothing in our app reaches that. An iPhone sidesteps it entirely.

---

## BOUNTY ANSWERS

### Aurora Intents — Bring Any-Chain Liquidity to Monad _(1 of 2)_

**How the project integrates an Aurora Intents product:**

We use **Intents Deposits** to give every hunter one permanent deposit address
that accepts twelve EVM chains and dozens of assets, and delivers **MON on
Monad**. Code: `lib/cota/aurora.ts`, `lib/cota/aurora-tokens.ts`, surfaced at
`/cota/onramp`.

Delivering MON rather than a stablecoin is the deliberate part. A newcomer who
arrives holding only a token cannot pay for their first transaction; landing
them in the gas asset means they can act the moment the deposit settles. We
found that dead end in testing and closed it.

Verified with real money: a 2 USDC transfer from Base settled in fourteen
seconds, and both the departure and arrival rows are visible in the arrivals
list on `/cota/onramp`.

### Agora — Best Mobile Trading App on Monad _(0 of 2)_

Phone-first by construction, not a desktop app shrunk down. The wallet is a
passkey, so there is no extension and no seed phrase; the trading screen is a
single control sized for a thumb — pick a percentage, pick long or short,
press once. That one press does four things under one signature: sells MON for
AUSD on Kuru's order book, deposits to Perpl, signs the bound as EIP-712 and
anchors it on Monad, then opens the position.

It ships as an installable app: a web manifest for home-screen install, a
signed Android APK, and an iOS build via GitHub Actions. Mera auth, AUSD
balances and Perpl trades all work on a phone with no desktop step.

### Kuru — Build the Next Consumer Trading App on Kuru _(0 of 4)_

Kuru is the execution venue for the MON→AUSD leg of every trade, chosen over
our own oracle desk specifically because the order book gives a consumer a
real price. `lib/cota/kuru.ts`, `lib/cota/kuru-swap.ts`.

What we learned and built around, all on mainnet:

- Kuru uses **both** of its contracts as the ERC-20 spender depending on the
  route, so we approve `quote.transaction.to` rather than a hardcoded address.
  Approving the wrong one returns `TransferFromFailed()` / `0x7939f424`.
- An unroutable amount returns **HTTP 200 with empty calldata**, which passes
  every type check and reverts anonymously on chain. We reject it before
  sending.
- A buy pays out **native MON, which emits no Transfer event**, so P&L is
  decoded from the Flow entrypoint's own swap event, cross-checked against
  `debug_traceTransaction`.

Consumer-facing result: `/cota/spot` shows FIFO cost basis and realised P&L
per trade, built from receipts rather than from what the browser remembered.

### Chainlink — Best workflow with CRE _(0 of 2)_

**QUALIFIES. The bounty says "Build, simulate, or deploy" — simulate is an accepted path.**

`cre/agent-scheduler/` contains a CRE workflow that schedules the Cota agent:
`main.ts`, `workflow.yaml`, staging and production config, and `SIMULATION.md`
recording a real `cre workflow simulate` run, which makes a live HTTPS call to
our agent endpoint.

It is **not deployed**. `cre whoami` reports "Deploy Access: Not enabled" and
`cre account access` returns "Deployment access is not yet enabled for your
organization". CI API-key auth is gated behind the same approval. The agent is
currently scheduled by GitHub Actions.

### Perpl — Best use of Perpl's API _(0 of 2)_

Perpl is the venue the whole product is built around, and the API key's
inability to withdraw is load-bearing: it is why a compromised agent is
bounded rather than catastrophic. A delegated key can open and close positions
and cannot move funds out, and Perpl enforces that, not us.

Live use: account creation and funding (`lib/cota/deposit.ts`), order
placement and reduce-only closes (`lib/cota/trade.ts`, `lib/cota/close.ts`),
reconciliation against fills, and a builder code (9) taking at most 2 bps of
routed volume, disclosed inside the user's signature.

Measured facts we had to design around: `min_deposit_amount` and
`min_account_open_amount` are both $10; the live fill floor is $3 notional;
and Perpl's mark can sit **outside** the book, below the bid — observed twice
— so we never price a fill from it.

### Perpl — Best Analytics / Risk Tool _(0 of 2)_

`/cota/risk` is a live risk view per hunter: open position, entry, mark, the
bid the position would actually close at, distance to the take-profit, and
what the bound still permits. `/cota/history` reconciles orders against fills,
checking size **and** entry price rather than existence.

The honest detail that shaped it: Perpl's fills arrive with `source: null`, so
`filledAt` is the reconcile moment and not the fill time. We say so in the UI
rather than presenting a timestamp we cannot stand behind.

### Kimi — Best Builds Powered by KIMI _(link required)_

**REMOVE THIS BOUNTY unless you actually used Kimi.** See note below.

### Monad Foundation — Best Mera-Powered UX _(1 of 2)_

Mera is the entire account layer. There is no email, no seed phrase, no
extension and no embedded-wallet SDK — we deleted the one we had rather than
leave a second path that could hand somebody the wrong wallet.

A hunter's first action is touching the sensor on their phone. The wallet
exists after that, and the same passkey signs every subsequent action, because
the trading key is derived from the passkey's PRF rather than stored.

### Monad Foundation — Mera: One Passkey, Many Keys _(1 of 2)_

One passkey, two independent derivations from **different PRF salts**:

1. The **wallet key** — the EVM account that holds and signs.
2. A **non-extractable AES-GCM vault key** (`lib/auth/vault-key.ts`) that is
   not a wallet at all. It seals a hunter's private notes in the browser.
   Same passkey, different salt, and the second key can never spend.

This is the "many keys" claim literally: one gesture, two keys, one of which
has no spending authority by construction.

---

## WHAT ONLY YOU CAN DO

1. **Project logo** — square, PNG/JPG/WEBP, max 2 MB, at least 500 px. The
   brand mark is the climber/mountain art, not the globe or the E monogram.
2. **Technical demo video** — up to 3 min. Script: `docs/submission-videos.md`.
3. **Pitch video** — up to 2 min. Same file.
4. **Share the private repo** with `metropolis@hackathon.monad.xyz`.
5. **Decide on Chainlink and Kimi** (below).

## TWO BOUNTIES TO DECIDE BEFORE SUBMITTING

**Chainlink CRE — it qualifies, submit it.** The bounty's own wording is
"Build, **simulate**, or deploy a Chainlink Runtime Environment (CRE) Workflow
used as an orchestration layer". Simulate is one of three accepted routes, not
a fallback, so a simulated workflow meets the requirement as written — read
off the Tracks & Bounties page 2026-10-08.

What exists: main.ts, workflow.yaml, staging and production config, and
SIMULATION.md recording a real `cre workflow simulate` run that makes a live
HTTPS call to the agent endpoint. Deploy access is separately gated —
`cre whoami` reports "Deploy Access: Not enabled" — but that is Chainlink's
Early Access gate and the bounty does not require clearing it.

State it plainly as simulated. The only thing to avoid is implying it is
deployed and driving the agent in production, which the judge page claimed
once and had to be corrected.

**Kimi.** There is no Kimi integration anywhere in this repository. If you did
not build with it, remove the bounty rather than submit a link to something
unrelated. An empty claim next to eight real ones is the thing a judge
remembers.
