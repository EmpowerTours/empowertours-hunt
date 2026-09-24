# After Metropolis — two things worth building, scoped

Written 2026-09-23. Both are post-13-October work: neither serves any of the
nine selected bounties, all of which are trading.

The two candidates are a **lending integration** (let idle assets earn) and a
**prop-style challenge product** (sell the leash as a rulebook), the second
aimed at The Trading Festival Mexico, 12–13 November, World Trade Center Mexico
City. Attendance is free for qualified visitors.

---

## 0. CORRECTION, 2026-09-24 — the survey changed the lending answer

Everything below about lending was written before surveying the market. The
survey contradicts parts of it, including a claim of mine that was simply wrong.
Read this section first.

### What is actually on Monad (DefiLlama API, 2026-09-24)

Thirteen protocols in the Lending category, not fifteen. The distribution is the
finding:

| Protocol | Monad TVL | 30d | 90d |
|---|---:|---:|---:|
| Aave V3 | $290.6M | +1% | — |
| Euler V2 | $261.5M | +11% | +141% |
| Morpho Blue | $196.2M | +7% | +124% |
| Curvance | $128.9M | −8% | +108% |
| **Neverland** | **$7.8M** | **−37%** | **−80%** |
| Gearbox | $0.30M | −35% | −57% |
| Folks Finance xChain | $0.23M | −14% | +6% |
| TownSquare Lending | $0.22M | −62% | −58% |
| Covenant | $0.03M | −39% | +24% |
| Peridot / Sumer / K613 / Quantus | <$1k each | | |

**The top four hold $877M of roughly $886M — about 99%.**

### The category is booming and every challenger is dying

Top-four TVL is **up 240% in 90 days**. This is not a shrinking market.

And yet, measured from each protocol's own peak:

    Gearbox            −99%
    TownSquare         −95%
    Folks Finance      −94%
    Neverland          −83%
    Peridot            −73%

Not one Monad-native lending challenger is near its high, in a quarter when the
category tripled. The money went to four battle-tested cross-chain incumbents.

**Neverland — the protocol this plan was originally modelled on — is down 83%
from a $45.5M peak in May, and lost 37% in the last thirty days alone.** It ran
the experiment of "be the Monad-native lender with better tokenomics" at real
scale, and it is losing. That is the single most useful data point here.

The only thing growing outside the top four is **Reservoir Protocol**, a CDP at
$60M and **+1159% in 30 days**, sitting at its all-time high — a different
mechanism (minting against collateral), not a lending market.

### The niche I claimed does not exist

This document said fifteen protocols can lend and "none of them can prove their
rules." That is false, and it took two searches to find out:

- **Aave V3 credit delegation** — `approveDelegation()` sets a per-debt-token
  allowance for another address. An agent borrows against your collateral, up to
  a cap you set, per asset. There is already a public "credit line for agents"
  project built on it.
- **Euler V2 EVC operators** — delegate control of a sub-account to a contract
  or bot, with a 256-account bitmask, revocable at any time, plus a lockdown
  mode. The docs name stop-loss and intent-based trading as the use cases.

Delegated, limited, revocable agent access to a lending position is **shipped**
in the two largest lenders on this chain.

### What is actually different about the Cota bound, stated honestly

Narrower than "nobody can do this", and still real:

- Aave's limit is an **allowance** — how much of one asset may be borrowed. It
  says nothing about leverage, loss, frequency or market.
- Euler's limit is **scope** — which sub-accounts an operator may touch. Inside
  one, the docs are explicit that an operator "can move funds, borrow, repay,
  and perform any action on your behalf."
- The Cota bound is **behavioural**: market, venue, max leverage, max notional,
  trades per day, daily loss ceiling, expiry — checked before every order, fails
  closed, over a key the venue itself will not let withdraw.

Allowance and scope versus rules. That is a genuine difference, and it is about
**perpetuals**, which is what Cota trades — not lending, where the incumbents
already have the primitive.

### Revised verdict

**Do not build a lending protocol.** Seven teams ran that experiment on this
chain in this window and are down 73–99% while the category tripled.

**An integration still makes sense** and the target should change: the AUSD
yield idea below stands, but the venue should be one of the four that is
actually winning, not the one this was modelled on.

**The differentiated thing remains the bound over perps**, not over lending —
which is what section 2 already argues for.

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
