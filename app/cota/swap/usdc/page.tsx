"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { useAuthSlot } from "@/app/providers";
import { Button, Note, Panel } from "@/components/ui/primitives";
import { SignInPrompt } from "@/components/auth/SignInPrompt";
import { signInAccount } from "@/lib/auth/passkey";
import {
  explainSwapError,
  formatAusd,
  publicClient,
  swapGasReserveWei,
} from "@/lib/cota/swap";
import { convertUsdcToAusd, type KuruStep } from "@/lib/cota/kuru-swap";
import {
  AUSD as AUSD_TOKEN,
  kuruQuote,
  kuruToken,
  USDC,
} from "@/lib/cota/kuru";

// ---------------------------------------------------------------------------
// USDC -> AUSD. The second half of the on-ramp, on its own.
//
// WHY THIS IS A SEPARATE PAGE from /cota/swap rather than a mode inside it.
// That page is about MON: it reserves gas out of the balance being spent,
// formats 18 decimals, falls back to the oracle desk, and warns about swapping
// the whole balance. A hunter arriving from /cota/onramp shares none of that —
// Aurora already delivered their USDC, so the order-book leg that buys it has
// nothing to do, and there are two signatures instead of three.
//
// It exists because the onramp shipped a button labelled "Swap USDC -> AUSD"
// that pointed at the MON page, which answers a hunter holding only USDC with
// "you have no MON in your Cota wallet". That is the dead end the onramp was
// built to remove, reintroduced one screen later.
//
// THE GAS TRAP IS THE REAL HAZARD HERE. Someone who funded entirely through
// Aurora holds USDC and NO MON, and both the approval and the conversion are
// transactions they must pay for. They arrive able to see their money and
// unable to move it. The screen says so up front rather than letting them find
// out when the first signature fails.
// ---------------------------------------------------------------------------

type Lang = "es" | "en";
type Phase = "idle" | "working" | "done";

const ERC20_BALANCE = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** Kuru rate-limits quoting — three in a row returned 429. Debounce, do not poll. */
const QUOTE_DEBOUNCE_MS = 600;

const COPY = {
  es: {
    title: "Cambia USDC por AUSD",
    lede: "Perpl opera en AUSD. Si fondeaste desde otra red, tu saldo llegó como USDC — conviértelo aquí.",
    back: "← Cota",
    bal: "USDC disponible",
    amount: "USDC a cambiar",
    max: "Máx",
    get: "Recibes",
    go: "Cambiar",
    working: "Cambiando…",
    noUsdc: "No tienes USDC. Fondea desde otra red primero.",
    toOnramp: "Fondear desde cualquier red →",
    noGas:
      "No tienes MON para el gas. Esta operación son dos transacciones y ambas se pagan en MON. Caza algo de MON primero, o pide que te envíen un poco.",
    signIn: "Inicia sesión",
    done: "Listo. Ahora deposita el AUSD en Perpl.",
    goDeposit: "Depositar AUSD en Perpl →",
    steps: {
      quoting: "Cotizando…",
      "trading-on-book": "Operando…",
      approving: "Autorizando USDC…",
      converting: "Convirtiendo a AUSD…",
      done: "Listo",
    },
  },
  en: {
    title: "Swap USDC for AUSD",
    lede: "Perpl settles in AUSD. If you funded from another chain your balance arrived as USDC — convert it here.",
    back: "← Cota",
    bal: "USDC available",
    amount: "USDC to swap",
    max: "Max",
    get: "You get",
    go: "Swap",
    working: "Swapping…",
    noUsdc: "You have no USDC. Fund from another chain first.",
    toOnramp: "Fund from any chain →",
    noGas:
      "You have no MON for gas. This is two transactions and both are paid in MON. Hunt some MON first, or have someone send you a little.",
    signIn: "Sign in",
    done: "Done. Now deposit the AUSD into Perpl.",
    goDeposit: "Deposit AUSD into Perpl →",
    steps: {
      quoting: "Quoting…",
      "trading-on-book": "Trading…",
      approving: "Approving USDC…",
      converting: "Converting to AUSD…",
      done: "Done",
    },
  },
} as const;

export default function SwapUsdcPage() {
  const lang = (useLocale() as Lang) ?? "en";
  const t = COPY[lang] ?? COPY.en;
  const auth = useAuthSlot();
  const signedIn = auth.status === "signed-in";
  const wallet = auth.walletAddress;

  const [usdcBalance, setUsdcBalance] = useState<bigint | null>(null);
  const [monBalance, setMonBalance] = useState<bigint | null>(null);
  const [gasPrice, setGasPrice] = useState<bigint | null>(null);
  const [input, setInput] = useState("");
  const [quote, setQuote] = useState<bigint | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [step, setStep] = useState<KuruStep | null>(null);
  const [ausdOut, setAusdOut] = useState<bigint | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!signedIn || wallet === null) return;
    let live = true;
    void (async () => {
      try {
        const pc = publicClient();
        const [usdc, mon, gas] = await Promise.all([
          pc.readContract({
            address: USDC,
            abi: ERC20_BALANCE,
            functionName: "balanceOf",
            args: [wallet as `0x${string}`],
          }) as Promise<bigint>,
          pc.getBalance({ address: wallet as `0x${string}` }),
          pc.getGasPrice(),
        ]);
        if (!live) return;
        setUsdcBalance(usdc);
        setMonBalance(mon);
        setGasPrice(gas);
      } catch {
        // Leaves both null, which renders as "…" rather than as zero. A zero
        // here would read as "you have nothing" and send a hunter away.
      }
    })();
    return () => {
      live = false;
    };
  }, [signedIn, wallet, phase]);

  const units = (() => {
    const n = Number(input);
    if (!Number.isFinite(n) || n <= 0) return 0n;
    return BigInt(Math.floor(n * 1e6));
  })();

  useEffect(() => {
    let live = true;
    if (units <= 0n || wallet === null) {
      // Cleared through the same path as a successful quote so the render
      // never shows a price for an amount nobody typed.
      const clear = setTimeout(() => {
        if (live) setQuote(null);
      }, 0);
      return () => {
        live = false;
        clearTimeout(clear);
      };
    }
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const token = await kuruToken(wallet);
          const q = await kuruQuote({
            token,
            userAddress: wallet,
            tokenIn: USDC,
            tokenOut: AUSD_TOKEN,
            amount: units,
          });
          if (live) setQuote(q.output);
        } catch {
          if (live) setQuote(null);
        }
      })();
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [units, wallet]);

  const run = useCallback(async () => {
    setPhase("working");
    setError(null);
    let session: Awaited<ReturnType<typeof signInAccount>> | null = null;
    try {
      session = await signInAccount();
      const result = await convertUsdcToAusd({
        account: session.account,
        usdcAmount: units,
        onStep: setStep,
      });
      setAusdOut(result.ausdOut);
      setTxHash(result.convertTxHash);
      setPhase("done");
    } catch (err) {
      setError(explainSwapError(err, lang));
      setPhase("idle");
    } finally {
      session?.session.end();
      setStep(null);
    }
  }, [units, lang]);

  if (!signedIn) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 py-6">
        <a href="/cota" className="text-ink/60 text-sm">
          {t.back}
        </a>
        <h1 className="text-ink text-xl font-semibold">{t.title}</h1>
        <SignInPrompt label={t.signIn} />
      </main>
    );
  }

  const noUsdc = usdcBalance !== null && usdcBalance === 0n;
  // Two transactions here — the approval and the conversion — against the MON
  // cost of one measured swap. Deliberately not exact: the point is to catch
  // the hunter who has NOTHING, not to compute a fee to the wei.
  const noGas =
    monBalance !== null &&
    gasPrice !== null &&
    monBalance < swapGasReserveWei(gasPrice);

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 py-6">
      <a href="/cota" className="text-ink/60 text-sm">
        {t.back}
      </a>
      <h1 className="text-ink text-xl font-semibold">{t.title}</h1>
      <p className="text-ink/70 text-sm">{t.lede}</p>

      <Panel>
        <div className="flex items-center justify-between">
          <span className="text-ink/60 text-xs uppercase">{t.bal}</span>
          <span className="text-ink font-mono text-sm">
            {usdcBalance === null ? "…" : formatAusd(usdcBalance)} USDC
          </span>
        </div>
      </Panel>

      {noGas ? <Note tone="warn">{t.noGas}</Note> : null}

      {noUsdc ? (
        <>
          <Note>{t.noUsdc}</Note>
          <a
            href="/cota/onramp"
            className="border-hull-line text-ink flex min-h-12 w-full items-center justify-center rounded-2xl border px-5 text-sm font-medium"
          >
            {t.toOnramp}
          </a>
        </>
      ) : phase === "done" ? (
        <Panel>
          <p className="text-ink text-sm">
            {t.done} {ausdOut === null ? null : `+${formatAusd(ausdOut)} AUSD`}
          </p>
          {txHash ? (
            <a
              href={`https://monadscan.com/tx/${txHash}`}
              className="text-ink/60 mt-2 block font-mono text-xs break-all"
            >
              {txHash}
            </a>
          ) : null}
          <a
            href="/cota/deposit"
            className="bg-phosphor/10 border-phosphor/40 text-ink mt-3 flex min-h-12 w-full items-center justify-center rounded-2xl border px-5 text-sm font-medium"
          >
            {t.goDeposit}
          </a>
        </Panel>
      ) : (
        <Panel>
          <label className="text-ink/60 text-xs uppercase" htmlFor="usdc-in">
            {t.amount}
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input
              id="usdc-in"
              inputMode="decimal"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              className="border-hull-line text-ink min-h-12 w-full rounded-2xl border bg-transparent px-4 font-mono text-sm"
              placeholder="0.00"
            />
            <button
              type="button"
              onClick={() =>
                setUsdcBalance((b) => {
                  if (b !== null) setInput(formatAusd(b));
                  return b;
                })
              }
              className="text-ink/60 shrink-0 text-xs underline"
            >
              {t.max}
            </button>
          </div>
          <p className="text-ink/60 mt-2 text-xs">
            {t.get}: {quote === null ? "…" : `${formatAusd(quote)} AUSD`}
          </p>
          <Button
            onClick={run}
            disabled={phase === "working" || units <= 0n || noGas}
            className="mt-3"
          >
            {phase === "working"
              ? step !== null
                ? t.steps[step]
                : t.working
              : t.go}
          </Button>
        </Panel>
      )}

      {error ? <Note tone="stop">{error}</Note> : null}
    </main>
  );
}
