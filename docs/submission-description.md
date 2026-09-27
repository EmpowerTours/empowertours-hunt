# Project description — submission copy

Paste-ready. Every number in it is checkable, and most are checkable by the
judge without leaving the product: `/judge` walks them through it, and
`/judge/record` is read live from the production table.

Deliberately not padded. Founder & Market Readiness is 25% of the score and
Traction another 20, and a panel that has read forty inflated submissions by
lunchtime rewards the one that states its size and means it.

---

## The description

**Cota is a permission layer for software that trades your money.**

Everyone says AI agents will trade for us. Nobody says what stops one. Before
any agent acts, a user signs a Cota: one market, a maximum leverage, a maximum
position size, a daily loss ceiling, an expiry — written in plain language and
as EIP-712 typed data. That signature is the agent's entire authority. Every
proposed order is checked against it by a pure function with no clock, no
database and no network, which fails closed, and the trading key can open and
close positions but can never withdraw — Perpl enforces that, not us. A fully
compromised agent is still bounded to what the person signed.

**That is not a claim, it is a table.** On 4 September the live agent asked one
bound for four trades inside the same second. It allowed one and refused three:
DOGE because the Cota did not name that market, then BTC twice for exceeding
leverage and size. Those rows are at /judge/record, written by the executor, not
staged for judging. Four real fills on Perpl sit underneath them.

**Getting in is the other half.** Our players are in Guerrero, Mexico. They have
never opened an exchange and never will, so the wallet is a face: one passkey
tap, no seed phrase, no extension, no email, no KYC queue. Mera is the entire
account layer — we deleted the embedded-wallet SDK rather than leave a second
path that could hand someone the wrong wallet. And the money can arrive from
anywhere: one permanent address per hunter accepts twelve EVM chains and dozens
of assets, and delivers MON on Monad so a newcomer can pay their own gas the
moment they land. A real 2 USDC transfer from Base settled in fourteen seconds.

**How the money is earned.** MON caches sit at GPS locations along walkable
corridors. Players walk there, check in with photo and GPS, and are paid on
Monad mainnet. Hunt earns you a wallet and a balance; Cota is where you put it
to work under a leash you control.

**Where it actually is.** Live on Monad mainnet. Eighteen leashes signed, 354
agent decisions, thirteen orders, four fills, one funded trading account, a
small group of real players. Small, and every number is real.

**How it sustains itself.** We are a Perpl builder (code 9). The Cota a user
signs authorises a small, disclosed builder fee of at most 10 bps of volume,
which Perpl settles to us. We profit from volume we route and never hold a peso
of anyone's funds.

**Judges:** start at /judge. Seven items work on an empty wallet, including the
one that matters.

---

## Notes on choices

- **The refusal leads, not the trading.** Anyone can show a chart. The only
  thing here nobody else has is software declining an instruction because of a
  number the user signed, where neither the user nor the operator can override
  it.
- **The small numbers are stated out loud.** One funded account, said plainly by
  someone who obviously built the whole thing, reads as credible. An invented
  hockey stick reads as an invented hockey stick.
- **Guerrero is in the second paragraph, not the first.** It is the reason the
  design is what it is, not a diversity note.
- **No mention of what is unbuilt.** Intents Connect, the lending integration
  and the prop-challenge product are real plans and belong in the pitch video's
  path-forward, not in a description of what exists.

## Before pasting

Re-read the live numbers first — `/judge/record` is generated from production,
so leashes, decisions, orders and fills all move. The four figures quoted above
were true on 2026-09-27.
