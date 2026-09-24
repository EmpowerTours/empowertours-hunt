# After Metropolis — two things worth building, scoped

Written 2026-09-23. Both are post-13-October work: neither serves any of the
nine selected bounties, all of which are trading.

The two candidates are a **lending integration** (let idle assets earn) and a
**prop-style challenge product** (sell the leash as a rulebook), the second
aimed at The Trading Festival Mexico, 12–13 November, World Trade Center Mexico
City. Attendance is free for qualified visitors.

---

## 1. Lending — integrate, do not build

### The case against building

Fifteen lending protocols are already live on Monad against roughly $410M of
chain TVL. The nearest comparison, Neverland, is an Aave V3 configuration with
**$104M TVL** (Jan 2026), audited twice by Composable Security (Aug 2025, Oct
2025), supporting WMON, WBTC, WETH, USDC and USDT, with a **6.8% USDC supply
APY** and veDUST tokenomics on top.

A sixteenth protocol, unaudited, bootstrapping from a desk holding $103, is not
a product. In lending the liquidity *is* the product, and the risk surface —
liquidation engines, bad debt, oracle manipulation timed by an attacker — is
different in kind from anything here today. The `MonAusdSwapOracle` work proves
the discipline exists; it does not shorten the road.

### The case for integrating, and the shape it should take

The interesting asset is **AUSD**, not USDC — because AUSD is already Cota's
asset. A hunter funds an account, signs a leash, and then the collateral sits
idle between trades. Every peso of that is dead weight today.

Venues that already take AUSD on Monad:

| Venue | Note |
|---|---|
| Upshift `earnAUSD` | a stablecoin yield vault, AUSD-denominated |
| Folks Finance | supplies AUSD into Curvance, Euler, Neverland and Morpho |

So the integration is: **idle AUSD earns; AUSD needed for margin does not.**
No liquidation engine of ours, no oracle of ours, no audit of ours, no TVL to
bootstrap.

### What it touches here

- `lib/cota/` gains a venue module in the shape of `aurora.ts` and `kuru.ts` —
  a client, a total parser, pinned constants, tests against a fixture.
- A route and a screen, following `/cota/onramp`.
- The hard part is **not** the integration. It is deciding how much AUSD may be
  lent while a leash is live, and getting it back before a position needs it.
  Perpl settles in AUSD; collateral inside a yield vault is collateral that is
  not there. That is a policy question with a wrong answer that liquidates
  somebody.

### Effort

- A read-only version — show the yield available, let a hunter move AUSD in and
  out by hand, never automatic: **about a week.** Low risk because the hunter
  decides.
- An automatic version — idle AUSD swept in, pulled back on margin need:
  **weeks**, and it needs the margin-safety policy written and tested first.

### Verdict

Worth doing, second. Start read-only. The automatic version is the one that can
cost somebody their position, and it should not be built in the same month as a
hackathon deadline.

---

## 2. The leash as a rulebook — for The Trading Festival

### The observation

A prop firm's product is a rulebook: max position size, max leverage, a daily
loss limit, and "break it and we cut you off." It is enforced by a dashboard and
a promise, and the firm can move the goalposts after a bad day.

`lib/cota/enforce.ts` is that rulebook, cryptographically. A signed EIP-712
bound, a pure function with no clock, no database and no network, that fails
closed, over a key Perpl will not let withdraw. Same rules, except a trader can
verify them and nobody can change them mid-challenge.

This is not a pivot. It is the existing enforcement engine with a different noun
on it.

### Why this venue

The Trading Festival Mexico runs five components; two matter here. The **Trading
Cup** is a live multi-asset competition across fifty instruments, two rounds
daily — it drew 700+ traders in Dubai. And the attendee list includes **prop
trading firms, IBs and affiliates**, which is the audience this argument is
written for.

The pitch is one sentence long, which is the most a booth ever gets: *the rules
are signed, on chain, and we cannot bend them.*

### What already exists

- `lib/cota/enforce.ts` — the bound checker, pure and fails closed
- `lib/cota/bound.ts`, the EIP-712 typed data, and on-chain anchoring
- `/cota/practice` — a paper simulator that runs **the same enforcement code**
  as the live path, which is the free evaluation tier already built
- Mera passkey sign-in: a stranger at a booth is trading in about twenty seconds
  with no seed phrase, no extension and no app install

### What is missing

- A challenge as a first-class object: a bound plus a duration plus a pass
  condition, anchored at the start so it cannot be edited later
- A leaderboard, and a verifiable result — the anchor is the proof
- A booth mode: a screen showing live standings, a QR to join

### Effort

- Booth demo — a signed bound, a paper account, a leaderboard: **about a week**,
  most of it UI, since the enforcement and the simulator already exist.
- A real evaluation product with funded accounts: **a month plus**, and it
  raises the same Mexican regulatory questions as everything else here (see
  `reference_mexico_crypto_lending_law` — client identification on every
  virtual-asset transaction, no threshold; non-custody is not a safe harbour).

### Verdict

Build this first. It reuses more of what exists than the lending work, it has a
date and a room full of the right people, and it is differentiated in a way a
lending integration can never be — fifteen protocols already lend, and none of
them can prove their rules.

---

## Sequence

1. **Now → 13 Oct:** Metropolis. The gap is the two videos, not code.
2. **14 Oct → 12 Nov:** the booth demo above, if TTF is on.
3. **After:** lending, read-only first.

## What would change this

- If TTF turns out to be the wrong room — brokers selling CFDs to retail, with
  no appetite for on-chain anything — then the prop angle loses its venue and
  the lending work moves up.
- If an AUSD yield venue offers something unusual, the order flips on economics
  rather than on strategy.
- Either way the decision is cheap to revisit, and neither is started before
  the submission is in.
