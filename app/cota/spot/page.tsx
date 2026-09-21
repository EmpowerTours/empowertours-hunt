"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { formatEther, parseEther, parseUnits } from "viem";
import { useAuthSlot } from "@/app/providers";
import { Button, Note, Panel, Pill } from "@/components/ui/primitives";
import { Sheet, SheetOpener } from "@/components/ui/Sheet";
import { SignInPrompt } from "@/components/auth/SignInPrompt";
import { LanguageSwitch } from "@/components/hunt/LanguageSwitch";
import { signInAccount } from "@/lib/auth/passkey";
import { publicClient, walletClientFor } from "@/lib/cota/swap";
import { KURU_EXECUTOR, USDC, kuruQuote, kuruToken } from "@/lib/cota/kuru";
import type { KuruBook } from "@/lib/cota/kuru-book";
import {
  explainFailure,
  gasFor,
  gasReserveWei,
  quoteAcceptable,
  received as receivedFrom,
} from "@/lib/cota/spot-trade";
import {
  gasBps,
  gasMon,
  outcomeOf,
  receivedText,
  spentMon,
  type TradeRow,
} from "@/lib/cota/trade-log";

// ---------------------------------------------------------------------------
// Spot. MON against USDC, on Kuru's order book, both directions.
//
// Everything else in Cota is a perpetual: leverage, a leash, an agent acting
// inside limits somebody signed. This is the opposite and is here deliberately.
// A hunter who has finished trading and wants out of MON has, until now, had no
// way to do it — and a hunter who wants exposure without leverage or a Perpl
// account has had no way in.
//
// It is the hunter's own trade, signed in the page by the wallet their passkey
// derives. No leash governs it and no agent touches it, because neither should:
// a leash bounds what software may do on your behalf, and this is you.
//
// WHY MON/USDC AND NOT MON/AUSD. Kuru's MON_AUSD book is ~$5 deep and prices
// 17% away from the market. MON_USDC is the real one: tight, deep, 0 bps both
// sides. Offering the thin book because its name matches our collateral token
// would be offering a worse price for tidiness.
//
// LAYOUT. Fixed height, nothing scrolls. The page is the same shape as the hunt
// screen and the landing page: header pinned, one region allowed to scroll, and
// the action within thumb reach at the bottom. The book itself goes in a Sheet
// rather than on the page, because fifteen levels of depth is reference
// material — worth having, never worth pushing the trade button off-screen for.
// ---------------------------------------------------------------------------

type Lang = "es" | "en";
type Side = "buy" | "sell";
type Phase = "idle" | "working" | "done" | "error";

const T = {
  es: {
    title: "Spot",
    lede: "Cambia MON por USDC en el libro de órdenes de Kuru. Tu operación, tu firma.",
    back: "Cota",
    signIn: "Inicia sesión para operar",
    buy: "Comprar MON",
    sell: "Vender MON",
    youPay: "Pagas",
    youGet: "Recibes ≈",
    amount: "Cantidad",
    trade: "Operar",
    working: "Operando… confirma con tu passkey",
    approving: "Autorizando USDC…",
    done: "Listo. Recibiste",
    book: "Libro de órdenes",
    seeBook: "Ver el libro",
    bid: "Compra",
    ask: "Venta",
    spread: "Spread",
    depth: "Profundidad",
    viewTx: "Ver la operación",
    onBook: "En el libro de Kuru",
    offBook: "Kuru enrutó por un pool",
    noBook: "No se pudo leer el libro ahora.",
    noAmount: "Ingresa una cantidad.",
    keepGas: "Guarda algo de MON para el gas.",
    notEnough: "No tienes suficiente saldo.",
    level: "nivel",
    levels: "niveles",
    atLeast: "Mínimo garantizado",
    noRoute:
      "Kuru no devolvió una ruta que se pueda ejecutar. Intenta de nuevo.",
    revertedTx: "La operación se revirtió en la cadena:",
    history: "Tus operaciones",
    seeHistory: "Ver tus operaciones",
    noTrades: "Todavía no has operado.",
    gasLabel: "Gas",
    ofTrade: "del monto",
    revertedRow: "Revertida",
    filledRow: "Ejecutada",
    amountUnknown: "monto no visible en el recibo",
  },
  en: {
    title: "Spot",
    lede: "Trade MON against USDC on Kuru's order book. Your trade, your signature.",
    back: "Cota",
    signIn: "Sign in to trade",
    buy: "Buy MON",
    sell: "Sell MON",
    youPay: "You pay",
    youGet: "You get ≈",
    amount: "Amount",
    trade: "Trade",
    working: "Trading… confirm with your passkey",
    approving: "Approving USDC…",
    done: "Done. You received",
    book: "Order book",
    seeBook: "See the book",
    bid: "Bid",
    ask: "Ask",
    spread: "Spread",
    depth: "Depth",
    viewTx: "View the trade",
    onBook: "On Kuru's order book",
    offBook: "Kuru routed through a pool",
    noBook: "Couldn't read the book right now.",
    noAmount: "Enter an amount.",
    keepGas: "Keep some MON for gas.",
    notEnough: "Not enough balance.",
    level: "level",
    levels: "levels",
    atLeast: "At least",
    noRoute: "Kuru returned no route that would execute. Try again.",
    revertedTx: "The trade reverted on-chain:",
    history: "Your trades",
    seeHistory: "See your trades",
    noTrades: "No trades yet.",
    gasLabel: "Gas",
    ofTrade: "of the trade",
    revertedRow: "Reverted",
    filledRow: "Filled",
    amountUnknown: "amount not visible in the receipt",
  },
} as const;

/**
 * Fallback reserve, used only until the live gas price arrives.
 *
 * Sized for the blind worst case at a high price rather than a typical one: it
 * is better to briefly understate the max than to offer a max that cannot pay
 * its own gas, which is what a flat 0.05 did on every trade this screen has
 * ever made. See gasReserveWei.
 */
const GAS_RESERVE_FALLBACK = parseEther("0.2");
const NATIVE = "0x0000000000000000000000000000000000000000";

const ERC20 = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "o", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "o", type: "address" },
      { name: "s", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "s", type: "address" },
      { name: "v", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

export default function SpotPage() {
  const lang: Lang = useLocale() === "es" ? "es" : "en";
  const t = T[lang];
  const auth = useAuthSlot();
  const address = auth.walletAddress as `0x${string}` | null;

  const [side, setSide] = useState<Side>("sell");
  const [input, setInput] = useState("");
  const [book, setBook] = useState<KuruBook | null>(null);
  const [out, setOut] = useState<bigint | null>(null);
  // The floor, shown next to the estimate. Widening slippage without printing
  // what a hunter is guaranteed would be quietly taking the difference.
  const [floor, setFloor] = useState<bigint | null>(null);
  const [onBook, setOnBook] = useState<boolean | null>(null);
  const [monBal, setMonBal] = useState<bigint | null>(null);
  // Read live, because the reserve is priced in MON and the price moves.
  const [gasPrice, setGasPrice] = useState<bigint | null>(null);
  const [usdcBal, setUsdcBal] = useState<bigint | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [approving, setApproving] = useState(false);
  const [tx, setTx] = useState<string | null>(null);
  const [got, setGot] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [log, setLog] = useState<TradeRow[] | null>(null);
  const [logSheet, setLogSheet] = useState(false);

  const loadLog = useCallback(async () => {
    if (!address) return;
    try {
      const r = await fetch(
        `/api/cota/kuru/history?wallet=${address}&limit=20`,
        { cache: "no-store" },
      );
      const j = (await r.json()) as { trades?: TradeRow[] };
      setLog(r.ok && j.trades ? j.trades : []);
    } catch {
      // A log that cannot load is not a reason to block trading. It renders as
      // "no trades yet" and the next load fixes it.
      setLog([]);
    }
  }, [address]);

  useEffect(() => {
    // Deferred to a microtask, the same way the quote effect below does it:
    // loadLog sets state, and calling it synchronously from an effect body is
    // what react-hooks/set-state-in-effect exists to stop.
    void Promise.resolve().then(loadLog);
  }, [loadLog]);

  /**
   * Hand a hash to the server, which reads the receipt and records what really
   * happened. Deliberately NOT told whether the trade succeeded or which venue
   * it used — those come off the chain, so a bug on this screen cannot write a
   * wrong history.
   *
   * Failures are swallowed. A trade already executed by the time this runs, and
   * an unrecorded trade is a worse outcome than a missing row but a far better
   * one than an error message about bookkeeping over a fill that worked.
   */
  const record = useCallback(
    async (hash: string) => {
      try {
        await fetch("/api/cota/kuru/history", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hash, side }),
        });
      } catch {
        /* the trade stands either way */
      }
    },
    [side],
  );

  // The book, via our own route — exchange.kuru.io sends no CORS header.
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const r = await fetch("/api/cota/kuru/book", { cache: "no-store" });
        const j = (await r.json()) as KuruBook & { error?: string };
        if (live) setBook(r.ok ? j : null);
      } catch {
        if (live) setBook(null);
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 10_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!address) return;
    const pc = publicClient();
    try {
      setMonBal(await pc.getBalance({ address }));
      setGasPrice(await pc.getGasPrice());
      setUsdcBal(
        (await pc.readContract({
          address: USDC,
          abi: ERC20,
          functionName: "balanceOf",
          args: [address],
        })) as bigint,
      );
    } catch {
      // The poll below retries; a dropped read must not strand the display.
    }
  }, [address]);

  useEffect(() => {
    let live = true;
    // Past a microtask, so this is not the synchronous set-state-in-effect the
    // lint forbids — the same shape app/cota/page.tsx already uses.
    const tick = () => {
      if (live) void refresh();
    };
    void Promise.resolve().then(tick);
    const id = setInterval(tick, 12_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [refresh]);

  // Live quote, debounced. All state set inside the timer, never in the body.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        if (!address || !input) {
          if (!cancelled) {
            setOut(null);
            setFloor(null);
            setOnBook(null);
          }
          return;
        }
        let amount: bigint;
        try {
          amount = side === "sell" ? parseEther(input) : parseUnits(input, 6);
        } catch {
          if (!cancelled) setOut(null);
          return;
        }
        if (amount <= 0n) {
          if (!cancelled) setOut(null);
          return;
        }
        try {
          const token = await kuruToken(address);
          const q = await kuruQuote({
            token,
            userAddress: address,
            tokenIn: side === "sell" ? NATIVE : USDC,
            tokenOut: side === "sell" ? USDC : NATIVE,
            amount,
          });
          if (!cancelled) {
            setOut(q.output);
            setFloor(q.minOut);
            // Measured from the calldata about to be signed, not assumed. The
            // router picks a venue per quote and the label must follow it.
            setOnBook(q.usesOrderBook);
          }
        } catch {
          if (!cancelled) {
            setOut(null);
            setFloor(null);
            setOnBook(null);
          }
        }
      })();
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [input, side, address]);

  const doTrade = useCallback(async () => {
    setError(null);
    if (!address || !input) {
      setError(t.noAmount);
      return;
    }
    let amount: bigint;
    try {
      amount = side === "sell" ? parseEther(input) : parseUnits(input, 6);
    } catch {
      setError(t.noAmount);
      return;
    }
    if (amount <= 0n) {
      setError(t.noAmount);
      return;
    }
    setPhase("working");
    try {
      const pc = publicClient();
      const { account } = await signInAccount();
      const token = await kuruToken(address);

      // Selling USDC pulls an ERC-20, and the spender is Kuru's EXECUTOR — not
      // the entrypoint the transaction is addressed to. Approving the wrong one
      // reverts with a correct allowance in place.
      if (side === "buy") {
        const allowance = (await pc.readContract({
          address: USDC,
          abi: ERC20,
          functionName: "allowance",
          args: [address, KURU_EXECUTOR],
        })) as bigint;
        if (allowance < amount) {
          setApproving(true);
          const h = await walletClientFor(account).writeContract({
            address: USDC,
            abi: ERC20,
            functionName: "approve",
            args: [KURU_EXECUTOR, amount],
          });
          await pc.waitForTransactionReceipt({ hash: h });
          setApproving(false);
        }
      }

      // Quote, simulate, re-quote past a route that will not execute. Kuru
      // intermittently returns one that reverts; retrying gets a working one.
      let sent: `0x${string}` | null = null;
      let received = 0n;
      let lastRevert: `0x${string}` | null = null;
      for (let attempt = 0; attempt < 4 && sent === null; attempt++) {
        const q = await kuruQuote({
          token,
          userAddress: address,
          tokenIn: side === "sell" ? NATIVE : USDC,
          tokenOut: side === "sell" ? USDC : NATIVE,
          amount,
        });
        // Cheaper than a simulation and catches a quote that could only ever
        // revert — a minOut above the output, or nothing out at all.
        if (!quoteAcceptable(q)) {
          await new Promise((r) => setTimeout(r, 1200));
          continue;
        }
        try {
          await pc.call({
            account: address,
            to: q.to,
            data: q.calldata,
            value: q.value,
          });
        } catch {
          await new Promise((r) => setTimeout(r, 1200));
          continue;
        }
        const before =
          side === "sell"
            ? ((await pc.readContract({
                address: USDC,
                abi: ERC20,
                functionName: "balanceOf",
                args: [address],
              })) as bigint)
            : await pc.getBalance({ address });
        // gasFor is tested: Monad charges the whole limit on a revert, so a
        // tight estimate buys a failed transaction at full price rather than
        // saving anything.
        let estimate: bigint | null = null;
        try {
          estimate = await pc.estimateGas({
            account: address,
            to: q.to,
            data: q.calldata,
            value: q.value,
          });
        } catch {
          // A failed estimate is not a reason to send nothing; gasFor floors it.
        }
        const gas = gasFor(estimate);
        const hash = await walletClientFor(account).sendTransaction({
          to: q.to,
          data: q.calldata,
          value: q.value,
          gas,
        });
        const receipt = await pc.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          // Keep the hash. A revert with no hash is a dead end — nobody can
          // look at what happened, which is how "it just says reverted" became
          // the whole bug report. Then try another route: the simulation
          // passed, so the book moved under it rather than the call being
          // wrong, and the next quote may well land.
          setTx(hash);
          lastRevert = hash;
          // Record the REVERT too. It cost the whole gas limit and delivered
          // nothing, which is precisely the trade a hunter needs to find again
          // — and a log of successes only would have hidden every one of the
          // failures that took this screen a week to get right.
          void record(hash);
          await new Promise((r) => setTimeout(r, 1200));
          continue;
        }
        const after =
          side === "sell"
            ? ((await pc.readContract({
                address: USDC,
                abi: ERC20,
                functionName: "balanceOf",
                args: [address],
              })) as bigint)
            : await pc.getBalance({ address });
        sent = hash;
        // Measured, not quoted. On a MON buy this is net of gas — what the
        // wallet actually gained — and it clamps at zero rather than showing a
        // negative number nobody can act on.
        received = receivedFrom(before, after);
      }
      if (sent === null) {
        const f = explainFailure(lastRevert, {
          noRoute: t.noRoute,
          revertedTx: t.revertedTx,
        });
        throw new Error(f.message);
      }
      setTx(sent);
      setGot(received);
      setPhase("done");
      void refresh();
      // Record, then reload — sequential, because the row has to exist before
      // the list that should contain it is fetched.
      void record(sent).then(loadLog);
    } catch (e) {
      setApproving(false);
      setError(e instanceof Error ? e.message : "failed");
      setPhase("error");
    }
  }, [
    address,
    input,
    side,
    t.noAmount,
    t.noRoute,
    t.revertedTx,
    refresh,
    record,
    loadLog,
  ]);

  const fmt = (v: bigint | null, dp: number) =>
    v === null ? "—" : (Number(v) / 10 ** dp).toFixed(4);

  /**
   * A level's worth, never rounded to "$0".
   *
   * toFixed(0) turned a real 0.000001 x 100,000 MON bid — ten cents of genuine
   * resting depth — into "$0" on a phone. A level that reads as worthless when
   * it is not is the same failure as mis-scaling the size: wrong in the
   * direction that makes a trader ignore depth that is actually there.
   */
  const usd = (n: number) =>
    n >= 1 ? `$${n.toFixed(0)}` : n > 0 ? `$${n.toFixed(2)}` : "$0";

  // Hold back enough to actually send the transaction. The old flat 0.05 was
  // less than the gas every real trade has paid, so tapping the balance built
  // an input the wallet could not afford to sign.
  const reserve =
    gasPrice === null ? GAS_RESERVE_FALLBACK : gasReserveWei(gasPrice);
  const maxMon = monBal !== null && monBal > reserve ? monBal - reserve : 0n;

  return (
    <main className="safe-top safe-bottom mx-auto flex h-dvh w-full max-w-md flex-col gap-3 overflow-hidden px-4">
      <header className="flex shrink-0 items-center justify-between gap-3 pt-1">
        <div className="min-w-0">
          <a href="/cota" className="text-ink-dim text-sm hover:underline">
            ← {t.back}
          </a>
          <h1 className="text-ink text-2xl font-bold tracking-tight">
            {t.title}
          </h1>
        </div>
        <LanguageSwitch />
      </header>

      {auth.status !== "signed-in" ? (
        <div className="flex min-h-0 flex-1 flex-col justify-center gap-4">
          <p className="text-ink-dim text-sm">{t.lede}</p>
          <SignInPrompt label={t.signIn} />
        </div>
      ) : (
        <>
          {/* The one region allowed to scroll. */}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
            <p className="text-ink-dim text-sm leading-snug">{t.lede}</p>

            <Panel className="space-y-2">
              <div className="text-ink-faint font-mono text-[11px] tracking-[0.18em] uppercase">
                MON / USDC · {t.book}
              </div>
              {book === null ? (
                <Note tone="warn">{t.noBook}</Note>
              ) : (
                <>
                  <div className="flex items-baseline justify-between font-mono">
                    <span className="text-phosphor">
                      {book.bestBidUsd?.toFixed(6)}
                    </span>
                    <span className="text-ink-faint text-xs">
                      {t.spread}{" "}
                      {book.spreadBps === null
                        ? "—"
                        : `${book.spreadBps.toFixed(1)} bps`}
                    </span>
                    <span className="text-alert">
                      {book.bestAskUsd?.toFixed(6)}
                    </span>
                  </div>
                  <SheetOpener onClick={() => setSheet(true)}>
                    {t.seeBook}
                  </SheetOpener>
                </>
              )}
              {log !== null && log.length > 0 && (
                <SheetOpener onClick={() => setLogSheet(true)}>
                  {t.seeHistory} ({log.length})
                </SheetOpener>
              )}
            </Panel>

            <div className="grid grid-cols-2 gap-2">
              {(["sell", "buy"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    setSide(s);
                    setInput("");
                    setOut(null);
                  }}
                  className={`min-h-12 rounded-2xl border-2 px-3 text-sm font-semibold ${
                    side === s
                      ? "border-phosphor text-phosphor"
                      : "border-hull-line text-ink-dim"
                  }`}
                >
                  {s === "sell" ? t.sell : t.buy}
                </button>
              ))}
            </div>

            <Panel className="space-y-3">
              <div className="flex items-baseline justify-between">
                <span className="text-ink-dim text-sm">
                  {t.youPay} {side === "sell" ? "MON" : "USDC"}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setInput(
                      side === "sell"
                        ? formatEther(maxMon)
                        : ((usdcBal ?? 0n) / 1_000_000n).toString(),
                    )
                  }
                  className="text-phosphor font-mono text-xs underline"
                >
                  {side === "sell" ? fmt(maxMon, 18) : fmt(usdcBal, 6)}
                </button>
              </div>
              <input
                inputMode="decimal"
                value={input}
                onChange={(e) =>
                  setInput(e.target.value.replace(/[^0-9.]/g, ""))
                }
                placeholder="0.0"
                className="border-hull-line text-ink w-full rounded-xl border-2 bg-transparent px-4 py-3 font-mono text-lg outline-none"
              />
              <div className="flex items-baseline justify-between">
                <span className="text-ink-dim text-sm">
                  {t.youGet} {side === "sell" ? "USDC" : "MON"}
                </span>
                <span className="text-ink font-mono text-lg">
                  {out === null ? "—" : fmt(out, side === "sell" ? 6 : 18)}
                </span>
              </div>
              {/* The guaranteed floor. The estimate is what the book says now;
                  this is what the transaction will refuse to go below, and on a
                  chain where simulation runs against state three blocks ahead
                  of execution, the difference is the part that can bite. */}
              {floor !== null && (
                <div className="flex items-baseline justify-between">
                  <span className="text-ink-faint text-xs">{t.atLeast}</span>
                  <span className="text-ink-faint font-mono text-xs">
                    {fmt(floor, side === "sell" ? 6 : 18)}
                  </span>
                </div>
              )}
              {onBook !== null && (
                <Pill color={onBook ? "#46ffbe" : "#47645d"}>
                  {onBook ? t.onBook : t.offBook}
                </Pill>
              )}
              {side === "sell" && (
                <p className="text-ink-faint text-xs">{t.keepGas}</p>
              )}
              {error && <Note tone="warn">{error}</Note>}
              {phase === "done" && got !== null && (
                <Note>
                  {t.done} {fmt(got, side === "sell" ? 6 : 18)}{" "}
                  {side === "sell" ? "USDC" : "MON"}
                  {tx && (
                    <>
                      {" · "}
                      <a
                        href={`https://monadscan.com/tx/${tx}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-phosphor underline"
                      >
                        {t.viewTx} →
                      </a>
                    </>
                  )}
                </Note>
              )}
            </Panel>
          </div>

          {/* Pinned: the action is never the thing you scroll to find. */}
          <div className="shrink-0 pb-1">
            <Button
              onClick={() => void doTrade()}
              disabled={phase === "working" || out === null}
            >
              {phase !== "working"
                ? t.trade
                : approving
                  ? t.approving
                  : t.working}
            </Button>
          </div>
        </>
      )}

      <Sheet
        open={sheet}
        onClose={() => setSheet(false)}
        label={t.book}
        closeLabel={lang === "es" ? "Cerrar" : "Close"}
        heading={`MON/USDC · ${(book?.asks.length ?? 0) + (book?.bids.length ?? 0)} ${
          (book?.asks.length ?? 0) + (book?.bids.length ?? 0) === 1
            ? t.level
            : t.levels
        }`}
      >
        {book === null ? (
          <Note tone="warn">{t.noBook}</Note>
        ) : (
          <div className="space-y-4 font-mono text-xs">
            <div>
              <div className="text-alert mb-1 tracking-[0.18em] uppercase">
                {t.ask}
              </div>
              {/* Asks nearest the spread last, so the book reads inward from
                  both edges the way a trader expects to see it. */}
              {[...book.asks].reverse().map((l, i) => (
                <div key={`a${i}`} className="flex justify-between py-0.5">
                  <span className="text-alert">{l.priceUsd.toFixed(6)}</span>
                  <span className="text-ink-dim">
                    {l.sizeMon.toFixed(0)} MON
                  </span>
                  <span className="text-ink-faint">{usd(l.notionalUsd)}</span>
                </div>
              ))}
            </div>
            <div>
              <div className="text-phosphor mb-1 tracking-[0.18em] uppercase">
                {t.bid}
              </div>
              {book.bids.map((l, i) => (
                <div key={`b${i}`} className="flex justify-between py-0.5">
                  <span className="text-phosphor">{l.priceUsd.toFixed(6)}</span>
                  <span className="text-ink-dim">
                    {l.sizeMon.toFixed(0)} MON
                  </span>
                  <span className="text-ink-faint">{usd(l.notionalUsd)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Sheet>

      {/* Your trades. Same Sheet as the book and for the same reason: a record
          that must not be truncated away, and must not push the trade button
          off the screen either. Every field here came off the chain — see
          app/api/cota/kuru/history/route.ts. */}
      <Sheet
        open={logSheet}
        onClose={() => setLogSheet(false)}
        label={t.history}
        closeLabel={lang === "es" ? "Cerrar" : "Close"}
        heading={`${log?.length ?? 0}`}
      >
        {log === null || log.length === 0 ? (
          <Note>{t.noTrades}</Note>
        ) : (
          <div className="space-y-3 font-mono text-xs">
            {log.map((row) => {
              const o = outcomeOf(row);
              const bps = gasBps(row);
              const gotText = receivedText(o);
              return (
                <div
                  key={row.hash}
                  className="border-hull-line space-y-1 border-b pb-3 last:border-0"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={row.ok ? "text-phosphor" : "text-alert"}>
                      {row.ok ? t.filledRow : t.revertedRow}
                    </span>
                    <span className="text-ink-faint">
                      {new Date(row.at).toLocaleDateString(
                        lang === "es" ? "es-MX" : "en-US",
                        { month: "short", day: "numeric" },
                      )}
                    </span>
                  </div>

                  <div className="flex justify-between">
                    <span className="text-ink-dim">
                      {row.side === "sell" ? t.sell : t.buy}
                    </span>
                    <span className="text-ink">
                      {/* Only meaningful on a sell; a buy spends USDC and
                          `valueWei` is zero. */}
                      {row.side === "sell" ? `${spentMon(row)} MON` : "—"}
                    </span>
                  </div>

                  {row.ok && (
                    <div className="flex justify-between">
                      <span className="text-ink-dim">{t.done}</span>
                      <span className="text-ink">
                        {/* Never "0". A MON buy pays out natively and emits no
                            Transfer, so the receipt truly does not hold the
                            amount — saying so beats inventing a zero. */}
                        {gotText ?? (
                          <span className="text-ink-faint">
                            {t.amountUnknown}
                          </span>
                        )}
                      </span>
                    </div>
                  )}

                  <div className="flex justify-between">
                    <span className="text-ink-dim">{t.gasLabel}</span>
                    <span className="text-ink">
                      {gasMon(row)} MON
                      {bps !== null && (
                        <span className="text-ink-faint">
                          {" "}
                          · {bps.toFixed(bps >= 10 ? 0 : 1)} bps {t.ofTrade}
                        </span>
                      )}
                    </span>
                  </div>

                  <div className="flex items-center justify-between gap-2 pt-1">
                    {/* The venue this trade REALLY used, read from its own
                        logs. The screen's pill is a prediction off the
                        calldata; this is what happened. */}
                    <Pill color={row.crossedOrderBook ? "#46ffbe" : "#47645d"}>
                      {row.crossedOrderBook ? t.onBook : t.offBook}
                    </Pill>
                    <a
                      href={`https://monadscan.com/tx/${row.hash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-phosphor shrink-0 underline"
                    >
                      {row.hash.slice(0, 10)}… →
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Sheet>
    </main>
  );
}
