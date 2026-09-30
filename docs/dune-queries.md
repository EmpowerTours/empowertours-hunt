# Dune queries — EmpowerTours on Monad mainnet

Written for the DeltaV Demo Day application, which gates on connecting an
analytics source. These exist so that connecting a Dune account surfaces
something real instead of an empty workspace.

Everything below was verified on 2026-09-29, not assumed:

- `monad.logs` is the raw log table and Monad mainnet is indexed on Dune.
- The `Anchored` topic0 was computed from the ABI in `lib/cota/anchor.ts` AND
  checked against a real receipt — tx
  `0x7a56d24debb2fe4f198817380b319c98a0f5e333561a122646f44d46b0a58b30`,
  block 102,785,139, which carries exactly that topic0 from exactly that
  contract.
- `nextSequence(0xe2ab4658…8395)` on AuditAnchorV2 returns **9**, so there are
  nine anchored leashes to find.
- **Dune's Monad coverage reaches back to at least 2026-07-30** — confirmed by
  running query 1, which returned rows from that date onward.

## What is ours, and what is not

This matters more than the SQL. A dashboard that counts a whole protocol's
traffic as our traction is the kind of claim that gets checked.

| Address                                      | What            | Ours?                                                                       |
| -------------------------------------------- | --------------- | --------------------------------------------------------------------------- |
| `0x8422b555DCE11913A4657C2f47C839637FC71ffd` | AuditAnchorV2   | **Yes** — but shared between Cota and quantum-portfolio. Split by anchorer. |
| `0x273b43e8E69E8c252e8470e9BB3C577331Ec52DE` | MonAusdSwap     | **Yes**                                                                     |
| `0x34b6552d57a35a1d042ccae1951bd1c370112a6f` | Perpl exchange  | **No** — Perpl's. Only our users' rows are ours.                            |
| `0x2f84fb8982073f39ba47c7fcc29119af074abbcb` | Kuru executor   | **No** — Kuru's. Same caveat.                                               |
| `0xb3e6778480b2e488385e8205ea05e20060b813cb` | Kuru entrypoint | **No**                                                                      |

Never chart a third-party contract's totals as a product metric. Where one is
needed, filter to `tx_from` in our own set of hunter addresses.

---

## 0. The contract holds MORE than our leashes — split by anchorer first

Run this before quoting any total. AuditAnchorV2 is shared with
quantum-portfolio, and a count of the contract is **not** a count of Cota.

Measured 2026-09-29: **17 anchors from THREE addresses, all of them ours.**

| Address | Anchors | Window | What it is |
|---|---|---|---|
| `0xe2ab4658…8395` | 9 | 7–15 Sep | Mera passkey wallet — **the Cota leashes** |
| `0x8dF64bAC…8ec1` | 7 | 30 Jul–30 Aug | main deployer — quantum-portfolio |
| `0x7D5BE289…6853` | 1 | 1 Sep | the founder's MetaMask |

No outside party has ever used this contract. The first Cota anchor reads
`2026-09-07 15:07:52` here against `15:07:53` in the database — the same event,
confirmed independently from chain.

**So `COUNT(DISTINCT topic1)` is a WALLET count, not a user count.** Three
wallets, one person. Query 1's `hunters` column would read 3 and mean 1. At this
scale that distinction is the whole difference between a true statement and a
fabricated one, so do not put that column in front of anyone without the
sentence above next to it.

```sql
SELECT
    bytearray_substring(topic1, 13, 20) AS anchorer,
    COUNT(*)                            AS anchors,
    MIN(block_time)                     AS first_anchor,
    MAX(block_time)                     AS last_anchor
FROM monad.logs
WHERE contract_address = 0x8422b555dce11913a4657c2f47c839637fc71ffd
  AND topic0 = 0xa58519225e4f9c8267cd9793b73fec57d8d8f98424e8f206c6d7288d6fe037e7
GROUP BY 1
ORDER BY anchors DESC
```

## 1. Leashes anchored per day

**Unfiltered — this counts BOTH products.** Add
`AND topic1 = 0x000000000000000000000000e2ab465839e409c80d1ca4bb4508fea7eb808395`
to restrict it to Cota.

The core product metric: a signed trading limit committed to chain. No
decoding, so nothing here depends on a Dune helper function.

```sql
SELECT
    block_date,
    COUNT(*)                  AS anchors,
    COUNT(DISTINCT topic1)    AS hunters
FROM monad.logs
WHERE contract_address = 0x8422b555dce11913a4657c2f47c839637fc71ffd
  AND topic0 = 0xa58519225e4f9c8267cd9793b73fec57d8d8f98424e8f206c6d7288d6fe037e7
GROUP BY 1
ORDER BY 1
```

`topic1` is the indexed `anchorer`, so `COUNT(DISTINCT topic1)` is distinct
wallets without needing to decode anything.

## 2. Every anchor, decoded

Same rows, with the address and sequence pulled out. If Dune ever renames a
helper, query 1 still works and this one is the nice-to-have.

```sql
SELECT
    block_time,
    bytearray_substring(topic1, 13, 20)  AS anchorer,
    topic2                               AS leash_digest,
    bytearray_to_uint256(topic3)         AS sequence,
    tx_hash
FROM monad.logs
WHERE contract_address = 0x8422b555dce11913a4657c2f47c839637fc71ffd
  AND topic0 = 0xa58519225e4f9c8267cd9793b73fec57d8d8f98424e8f206c6d7288d6fe037e7
ORDER BY block_time DESC
```

`sequence` is per-anchorer and strictly increasing — the chain is what makes
the log append-only, so a gap in it is evidence, not noise.

## 3. Cumulative anchors, for the "is this growing" chart

```sql
WITH daily AS (
    SELECT block_date, COUNT(*) AS anchors
    FROM monad.logs
    WHERE contract_address = 0x8422b555dce11913a4657c2f47c839637fc71ffd
      AND topic0 = 0xa58519225e4f9c8267cd9793b73fec57d8d8f98424e8f206c6d7288d6fe037e7
    GROUP BY 1
)
SELECT
    block_date,
    anchors,
    SUM(anchors) OVER (ORDER BY block_date) AS cumulative
FROM daily
ORDER BY 1
```

## 4. MonAusdSwap activity

Ours outright. Counts transactions rather than logs so it does not depend on
knowing the event signatures.

```sql
SELECT
    block_date,
    COUNT(*)                AS swaps,
    COUNT(DISTINCT "from")  AS wallets
FROM monad.transactions
WHERE to = 0x273b43e8e69e8c252e8470e9bb3c577331ec52de
  AND success
GROUP BY 1
ORDER BY 1
```

## 5. Distinct wallets that have ever touched an EmpowerTours contract

The honest top-line. Only contracts we own.

```sql
SELECT COUNT(DISTINCT "from") AS wallets
FROM monad.transactions
WHERE to IN (
        0x8422b555dce11913a4657c2f47c839637fc71ffd,  -- AuditAnchorV2
        0x273b43e8e69e8c252e8470e9bb3c577331ec52de   -- MonAusdSwap
      )
  AND success
```

---

# The set to actually save (2026-09-29)

Dune's free tier went **view-only on 2026-09-10**: no credits, no query
execution, no API. A new account gets 2,500 trial credits for 14 days and then
hits the same wall. Paid starts at $399/mo.

**Saved RESULTS stay viewable after the trial** — view-only means you cannot
re-execute, not that the data disappears. So run these once, save each, and a
dashboard built from them keeps rendering. Never build anything that depends on
them re-running.

Because credits are finite, the two queries using helper functions are last: a
wrong function name costs a credit for nothing.

Filter for Cota only — the Mera passkey wallet, padded to the 32-byte topic:

    AND topic1 = 0x000000000000000000000000e2ab465839e409c80d1ca4bb4508fea7eb808395

`"from"` and `"to"` must be double-quoted in `monad.transactions`. Addresses are
unquoted `0x…` varbinary literals — proven in a real run, whatever the docs'
example shows.

1. `Cota — leashes anchored per day` — query 1 above plus the topic1 filter, and
   **without** a `hunters` column.
2. `Cota — cumulative leashes anchored` — query 3 plus the topic1 filter.
3. `AuditAnchorV2 — anchors by wallet` — query 0. The one to show a judge: it
   gives the 9 / 7 / 1 decomposition rather than a headline, and uses no helper
   functions so it cannot fail on a name.
4. `MonAusdSwap — daily activity` — query 4. May be legitimately empty.
5. `Cota — every leash anchored` — query 2. Uses `bytearray_substring` and
   `bytearray_to_uint256`; if either errors, drop those columns and keep
   `block_time, topic2, tx_hash`.

**Skip query 5 (distinct wallets across our contracts) entirely.** It has the
wallets-versus-people problem in its purest form and the honest answer today is
one person.

**PostHog, not Dune, is the connector to hang the DeltaV application on.** It is
live, verified, EU, and its free tier does not expire. Dune here is an artifact
to point at, not a feed to depend on.

---

## Reading these honestly

As of 2026-09-29 the number of anchored **Cota** leashes is **9**, from **one**
wallet. The contract shows 17 because quantum-portfolio anchors to the same
place; do not quote that figure as Cota's.
That is a real, independently verifiable on-chain record of the product
working, and it is also one user. Both halves are true and the second one does
not stop being true because the first is on a chain.

If these charts are going in front of anyone, say what they are: evidence that
the mechanism runs, not evidence of demand.

---

# BUILT — 2026-09-29

All five exist as saved queries on Dune, executed against real data, under the
account **`@toursempower`** (the one the MCP authenticated into and the one
holding the trial credits). **Connect THAT account to DeltaV** — a connector
pointed at `@empowertours` finds an empty workspace.

**Dashboard:** https://dune.com/toursempower/cota-signed-trading-limits-anchored-on-monad

| Query | ID | Result |
|---|---|---|
| Cota — leashes anchored per day | 8863873 | 3 rows: 1 / 7 / 1 |
| AuditAnchorV2 — anchors by wallet | 8863874 | 3 rows: 9 / 7 / 1 |
| Cota — cumulative leashes anchored | 8863878 | ends at 9 |
| Cota — every leash anchored | 8863879 | 9 rows, sequence 0–8 unbroken |
| MonAusdSwap — daily activity | 8863895 | 1 row: 2026-09-13, 5 swaps, 2 wallets |

The audit trail reconciles against the application's own database: sequence 0 is
tx `0x7a56d24d…a58b30` at 2026-09-07 15:07:52, sequence 1 is `0x4b536ddc…`,
sequence 2 is `0x76da589a…` — the same hashes `Cota.anchorTxHash` holds. Chain
and database agree on the transactions, not merely on the counts.

MonAusdSwap is deliberately NOT on the dashboard. It is real and it is ours, but
the swap desk is not Cota and five transactions on one day adds no signal to a
claim about the leash.

## Engine notes (credits are finite now)

- The `free` engine **times out after 2 minutes** on `monad.logs` and is often
  *more* expensive than `small` when it does finish — 2.8 credits for a grind
  versus 0.35 for the same query on `small`. Use `small` for logs.
- `monad.transactions` needs **`medium`**; it timed out on `small`.
- The free engine allows only **3 parallel executions**.
- 5 queries, several retries: **~23 credits of 2,500**. Cost is not the
  constraint; the 14-day trial window (30 Sep – 14 Oct) is. That window does
  cover the Metropolis close on 13 Oct.

## The funnel that wasn't, and what replaced it (2026-09-29)

Checked whether the swap-desk wallets overlap the anchoring wallet before
drawing any funnel. They do, but not usefully:

| Wallet | Swaps | When | Who |
|---|---|---|---|
| `0x8dF64bAC…8ec1` | 4 | 13 Sep 01:15–01:44 | main deployer — testing |
| `0xe2ab4658…8395` | 1 | 13 Sep 19:45 | the Cota hunter wallet |

**So no funnel was drawn.** Two wallets, one of them a test. A funnel asserts a
population and a drop-off rate; two is not a population, and 50% of two is an
anecdote with a percentage sign on it.

What the data DID support is better: the same wallet appears at every stage, so
the story is one complete loop rather than a cohort. Query **8863954**, `Cota —
the complete loop, one wallet, on chain`, 14 rows:

    07 Sep 15:07     first signed leash anchored
    07–08 Sep        eight leashes anchored
    13 Sep 19:45:25  swap MON → AUSD
    13 Sep 19:48:26  approve AUSD
    13 Sep 19:48:27  deposit to Perpl
    14 Sep 19:30     second Perpl deposit
    15 Sep 20:20     ninth leash anchored

Three minutes from swap to funded perps account; first fill 14 Sep 22:34.

Two scopes are stated in the query's own comments rather than hidden: the
wallet also did Kuru and edition-relayer work on 21 Sep for a different product
(excluded — it would pad the story), and **the fills are not on chain from this
wallet at all**, because Perpl forwards orders from its own infrastructure. An
executed trade is therefore not a transaction from the hunter; the fills live in
the app's ledger.

Supporting query **8863951** (`Cota — the hunter wallet's on-chain activity`)
lists all 10 counterparties, 23 transactions, if the scope ever needs defending.
