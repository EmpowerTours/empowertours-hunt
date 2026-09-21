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
  quoteAcceptable,
  received as receivedFrom,
} from "@/lib/cota/spot-trade";

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
    noRoute: "Kuru no devolvió una ruta que se pueda ejecutar. Intenta de nuevo.",
    revertedTx: "La operación se revirtió en la cadena:",
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
    noRoute: "Kuru returned no route that would execute. Try again.",
    revertedTx: "The trade reverted on-chain:",
  },
} as const;

/** Same reserve the swap page keeps: a trade that leaves no gas reverts. */
const GAS_RESERVE = parseEther("0.05");
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
  const [onBook, setOnBook] = useState<boolean | null>(null);
  const [monBal, setMonBal] = useState<bigint | null>(null);
  const [usdcBal, setUsdcBal] = useState<bigint | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [approving, setApproving] = useState(false);
  const [tx, setTx] = useState<string | null>(null);
  const [got, setGot] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);

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
            // Measured from the calldata about to be signed, not assumed. The
            // router picks a venue per quote and the label must follow it.
            setOnBook(q.usesOrderBook);
          }
        } catch {
          if (!cancelled) {
            setOut(null);
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
    } catch (e) {
      setApproving(false);
      setError(e instanceof Error ? e.message : "failed");
      setPhase("error");
    }
  }, [address, input, side, t.noAmount, t.noRoute, t.revertedTx, refresh]);

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

  const maxMon =
    monBal !== null && monBal > GAS_RESERVE ? monBal - GAS_RESERVE : 0n;

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
                  <span className="text-ink-faint">
                    {usd(l.notionalUsd)}
                  </span>
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
                  <span className="text-ink-faint">
                    {usd(l.notionalUsd)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Sheet>
    </main>
  );
}
