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

## Reading these honestly

As of 2026-09-29 the number of anchored **Cota** leashes is **9**, from **one**
wallet. The contract shows 17 because quantum-portfolio anchors to the same
place; do not quote that figure as Cota's.
That is a real, independently verifiable on-chain record of the product
working, and it is also one user. Both halves are true and the second one does
not stop being true because the first is on a chain.

If these charts are going in front of anyone, say what they are: evidence that
the mechanism runs, not evidence of demand.
