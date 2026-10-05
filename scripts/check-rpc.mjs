#!/usr/bin/env node
/**
 * Does a candidate Monad RPC endpoint actually do what Hunt and Cota need?
 *
 *   node scripts/check-rpc.mjs https://candidate.example/rpc
 *   MONAD_RPC_URL=... node scripts/check-rpc.mjs
 *
 * Written because the obvious choice is wrong: rpc1.monad.xyz has the best
 * eth_getLogs span and full archive state, and it refuses
 * debug_traceTransaction, which lib/cota/kuru-history.ts needs to price a Kuru
 * buy (the payout is native MON and emits no Transfer event). An endpoint can
 * look strictly better on a docs page and still break P&L silently.
 *
 * A provider URL usually carries an API key in the path or query, so nothing
 * here ever prints the URL back. See redact().
 */

const RAW = process.argv[2] || process.env.MONAD_RPC_URL;
if (!RAW) {
  console.error("usage: node scripts/check-rpc.mjs <rpc-url>");
  process.exit(2);
}

/** Never print a provider URL: the key lives in the path or the query. */
function redact(u) {
  try {
    const { protocol, host } = new URL(u);
    return `${protocol}//${host}/***`;
  } catch {
    return "<unparseable url>";
  }
}

const KURU_ENTRYPOINT = "0xb3e6778480b2e488385e8205ea05e20060b813cb";

async function rpc(method, params, timeoutMs = 30_000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(RAW, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ac.signal,
    });
    if (!res.ok) return { httpError: res.status };
    return await res.json();
  } catch (e) {
    return {
      httpError: e.name === "AbortError" ? "timeout" : String(e.message),
    };
  } finally {
    clearTimeout(t);
  }
}

const results = [];
function record(name, ok, detail, fatal = false) {
  results.push({ name, ok, detail, fatal });
  const mark = ok ? "PASS" : fatal ? "FAIL" : "warn";
  console.log(`  ${mark.padEnd(4)}  ${name.padEnd(34)} ${detail}`);
}

console.log(`\nChecking ${redact(RAW)}\n`);

// --- 1. the right chain ----------------------------------------------------
const cid = await rpc("eth_chainId", []);
const chainId = cid.result ? Number.parseInt(cid.result, 16) : null;
record(
  "chain id is 143",
  chainId === 143,
  chainId === null
    ? `no answer (${cid.httpError ?? cid.error?.message})`
    : `got ${chainId}`,
  true,
);

// --- 2. a plain read ------------------------------------------------------
const t0 = Date.now();
const bal = await rpc("eth_getBalance", [KURU_ENTRYPOINT, "latest"]);
const firstMs = Date.now() - t0;
record(
  "eth_getBalance at latest",
  typeof bal.result === "string",
  typeof bal.result === "string"
    ? `${firstMs} ms`
    : `failed: ${bal.httpError ?? bal.error?.message}`,
  true,
);

// --- 3. debug_traceTransaction, the one Cota cannot lose ------------------
// Find a real entrypoint tx via this same endpoint if it can scan; otherwise
// fall back to a known-good mainnet hash so the check still runs.
const tip = Number.parseInt(
  (await rpc("eth_blockNumber", [])).result ?? "0x0",
  16,
);
let sampleHash = null;
if (tip > 0) {
  for (const span of [100, 2_000, 50_000]) {
    const got = await rpc("eth_getLogs", [
      {
        address: KURU_ENTRYPOINT,
        fromBlock: "0x" + (tip - span).toString(16),
        toBlock: "0x" + tip.toString(16),
      },
    ]);
    if (Array.isArray(got.result) && got.result.length) {
      sampleHash = got.result[got.result.length - 1].transactionHash;
      break;
    }
  }
}
// A real Kuru entrypoint tx on Monad mainnet, for endpoints that cannot scan.
sampleHash ??=
  "0x56a1c47b8992813c8dbce4061ee05762afa42fd281bf25c6272251c22fe69e82";

const tr = await rpc(
  "debug_traceTransaction",
  [sampleHash, { tracer: "callTracer" }],
  60_000,
);
record(
  "debug_traceTransaction",
  !!tr.result,
  tr.result
    ? "callTracer answers"
    : `REFUSED: ${tr.error?.message ?? tr.httpError} — Cota cannot price a Kuru buy`,
  true,
);

// --- 4. receipts for an old tx (backfill depends on it) ------------------
const rec = await rpc("eth_getTransactionReceipt", [sampleHash]);
record(
  "receipt for a known tx",
  !!rec.result,
  rec.result ? "served" : `missing: ${rec.error?.message ?? rec.httpError}`,
  true,
);

// --- 5. informational: eth_getLogs span ---------------------------------
// We never call ranged eth_getLogs today, so this does not gate anything.
// Measured BEFORE the burst below, or the burst's own rate limiting makes an
// endpoint look like it has no range at all.
let span = 0;
for (const s of [100, 1_000, 10_000, 100_000]) {
  const got = await rpc("eth_getLogs", [
    {
      address: KURU_ENTRYPOINT,
      fromBlock: "0x" + (tip - s).toString(16),
      toBlock: "0x" + tip.toString(16),
    },
  ]);
  if (!Array.isArray(got.result)) break;
  span = s;
}
console.log(
  `  info  ${"eth_getLogs span".padEnd(34)} >=${span} blocks (nothing we run needs a range)`,
);

// --- 6. rate limit under a burst (why rpc.monad.xyz needs a fallback) ----
const BURST = 120;
const codes = {};
await Promise.all(
  Array.from({ length: BURST }, async () => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 25_000);
    try {
      const res = await fetch(RAW, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getBalance",
          params: [KURU_ENTRYPOINT, "latest"],
        }),
        signal: ac.signal,
      });
      codes[res.status] = (codes[res.status] ?? 0) + 1;
    } catch {
      codes.network = (codes.network ?? 0) + 1;
    } finally {
      clearTimeout(t);
    }
  }),
);
const refused = (codes[429] ?? 0) + (codes[503] ?? 0);
record(
  `holds ${BURST} concurrent reads`,
  refused === 0,
  refused === 0
    ? "no 429 — safe as the primary endpoint"
    : `${refused}/${BURST} refused (${JSON.stringify(codes)}) — keep a fallback behind it`,
);

// --- verdict -------------------------------------------------------------
const fatals = results.filter((r) => r.fatal && !r.ok);
const warns = results.filter((r) => !r.fatal && !r.ok);
console.log("");
if (fatals.length) {
  console.log(`VERDICT: unusable — ${fatals.map((f) => f.name).join(", ")}`);
  process.exit(1);
}
if (warns.length) {
  console.log(
    "VERDICT: usable, but rate-limited. Fine as the fallback leg; as MONAD_RPC_URL\n" +
      "         it still works because monadTransport() keeps rpc2 behind it.",
  );
  process.exit(0);
}
console.log(
  "VERDICT: good as MONAD_RPC_URL (leg 1). Set it in Railway, redeploy, and\n" +
    "         monadTransport() keeps rpc2.monad.xyz behind it automatically.",
);
