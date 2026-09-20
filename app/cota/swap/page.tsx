"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { formatEther, parseEther } from "viem";
import { useAuthSlot } from "@/app/providers";
import { Button, Note, Panel, Pill } from "@/components/ui/primitives";
import { SignInPrompt } from "@/components/auth/SignInPrompt";
import { LanguageSwitch } from "@/components/hunt/LanguageSwitch";
import { signInAccount } from "@/lib/auth/passkey";
import {
  formatAusd,
  minOut,
  publicClient,
  SWAP_ABI,
  SWAP_ADDRESS,
  explainSwapError,
  walletClientFor,
} from "@/lib/cota/swap";
import { swapMonToAusdViaKuru, type KuruStep } from "@/lib/cota/kuru-swap";
import { AUSD as AUSD_TOKEN, kuruQuote, kuruToken, USDC } from "@/lib/cota/kuru";

// ---------------------------------------------------------------------------
// MON -> AUSD. A hunter who only has MON turns it into AUSD here to fund a Perpl
// account. The MON leaves their Cota wallet (the passkey wallet), the AUSD lands
// in the same wallet. One passkey prompt per swap; the desk's staleness/slippage guards
// protect the price. This is the on-ramp the bridge page can't be for MON-only
// hunters.
// ---------------------------------------------------------------------------

type Lang = "es" | "en";
type Phase = "idle" | "swapping" | "done" | "error";

const T = {
  es: {
    title: "Cambia MON por AUSD",
    lede: "Perpl opera en AUSD. Convierte el MON que cazaste en AUSD para fondear tu cuenta.",
    signIn: "Inicia sesión para cambiar",
    wallet: "Tu billetera Cota",
    fund: "Envía MON a esta dirección para cambiarlo aquí.",
    monBal: "MON disponible",
    deskHas: "AUSD en la caja",
    amount: "MON a cambiar",
    youGet: "Recibes ≈",
    swap: "Cambiar",
    swapping: "Cambiando… confirma con tu passkey",
    done: "¡Listo! Recibiste",
    deskLow: "La caja no tiene suficiente AUSD para eso ahora.",
    tooLittle: "Ingresa una cantidad de MON.",
    noMon:
      "No tienes MON en tu billetera Cota. Envía MON a la dirección de arriba.",
    viewTx: "Ver transacción",
    next: "Ahora deposita el AUSD en Perpl y opera en Cota.",
    reverted:
      "La transacción se revirtió en la cadena — revisa tu MON y el precio. No se cambió nada.",
    back: "Cota",
    goTrade: "Depositar AUSD en Perpl →",
    keepGas: "Guarda algo de MON para el gas — no cambies todo tu saldo.",
    overMax: "Deja ~0.05 MON para el gas. Toca Máx.",
    max: "Máx",
    viaBook: "Vía el libro de órdenes de Kuru",
    viaDesk: "Vía la caja de EmpowerTours",
    bookNote:
      "Tu MON se opera en el libro de órdenes de Kuru (MON/USDC, 0 bps) y el USDC se convierte a AUSD. Son tres firmas: la operación, un permiso de USDC y la conversión.",
    deskNote:
      "Kuru no está disponible ahora, así que se usa la caja de EmpowerTours. Una sola firma.",
    stepBook: "1/3 Operando en el libro de Kuru…",
    stepApprove: "2/3 Autorizando USDC…",
    stepConvert: "3/3 Convirtiendo a AUSD…",
    viewBookTx: "Ver la operación en el libro",
    viaPool: "Vía Kuru (ruta por pool)",
    poolNote:
      "Kuru enrutó esta cantidad por un pool en vez del libro, porque ahí el precio es mejor para ti. Siguen siendo tres firmas.",
  },
  en: {
    title: "Swap MON for AUSD",
    lede: "Perpl trades in AUSD. Turn the MON you hunted into AUSD to fund your account.",
    signIn: "Sign in to swap",
    wallet: "Your Cota wallet",
    fund: "Send MON to this address to swap it here.",
    monBal: "MON available",
    deskHas: "AUSD in the desk",
    amount: "MON to swap",
    youGet: "You get ≈",
    swap: "Swap",
    swapping: "Swapping… confirm with your passkey",
    done: "Done! You received",
    deskLow: "The desk doesn't have enough AUSD for that right now.",
    tooLittle: "Enter an amount of MON.",
    noMon: "No MON in your Cota wallet. Send MON to the address above.",
    viewTx: "View transaction",
    next: "Now deposit the AUSD to Perpl and trade on Cota.",
    reverted:
      "The transaction reverted on-chain — check your MON balance and the price. Nothing was swapped.",
    back: "Cota",
    goTrade: "Deposit AUSD to Perpl →",
    keepGas: "Keep some MON for gas — don't swap your whole balance.",
    overMax: "Leave ~0.05 MON for gas. Tap Max.",
    max: "Max",
    viaBook: "Via Kuru's order book",
    viaDesk: "Via the EmpowerTours desk",
    bookNote:
      "Your MON trades on Kuru's order book (MON/USDC, 0 bps) and the USDC converts to AUSD. Three signatures: the trade, a USDC approval, and the conversion.",
    deskNote:
      "Kuru is unavailable right now, so this uses the EmpowerTours desk instead. One signature.",
    stepBook: "1/3 Trading on Kuru's book…",
    stepApprove: "2/3 Approving USDC…",
    stepConvert: "3/3 Converting to AUSD…",
    viewBookTx: "View the order-book trade",
    viaPool: "Via Kuru (routed through a pool)",
    poolNote:
      "Kuru routed this size through a pool rather than the order book, because the price there is better for you. Still three signatures.",
  },
} as const;

// Never swap the whole balance: a swap that leaves no MON for gas reverts
// underpriced (this is exactly what bit the first live test). Reserve this much
// MON for gas and cap the swap amount to it.
const GAS_RESERVE = parseEther("0.05");

export default function SwapPage() {
  const lang: Lang = useLocale() === "es" ? "es" : "en";
  const t = T[lang];
  const auth = useAuthSlot();

  const [monInput, setMonInput] = useState("");
  const [quote, setQuote] = useState<bigint | null>(null);
  const [available, setAvailable] = useState<bigint | null>(null);
  const [monBalance, setMonBalance] = useState<bigint | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [ausdOut, setAusdOut] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which on-ramp the quote came from. Kuru is preferred because the trade
  // lands on its order book at 0 bps; the desk is the fallback for when Kuru's
  // API or route is unavailable, and it depends on nothing but Monad.
  const [route, setRoute] = useState<"kuru-book" | "kuru-pool" | "desk">(
    "desk",
  );
  const [step, setStep] = useState<KuruStep | null>(null);
  const [bookTx, setBookTx] = useState<string | null>(null);

  const address = auth.walletAddress;

  // Desk float + wallet MON balance.
  const refreshBalances = useCallback(async () => {
    const pc = publicClient();
    // Retry: the public RPC drops the occasional read (worse under community
    // load), and a single silent failure used to strand the display on "…"
    // forever with no retry. Three attempts with backoff, then the 12s poll.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const avail = (await pc.readContract({
          address: SWAP_ADDRESS,
          abi: SWAP_ABI,
          functionName: "available",
        })) as bigint;
        setAvailable(avail);
        if (address) {
          setMonBalance(
            await pc.getBalance({ address: address as `0x${string}` }),
          );
        }
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }
  }, [address]);

  useEffect(() => {
    let live = true;
    const tick = () => {
      if (live) void refreshBalances();
    };
    tick();
    // Poll so the display self-heals if the first read (or a later one) drops,
    // and stays current as the wallet's MON changes.
    const id = setInterval(tick, 12000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [refreshBalances]);

  // Live quote, debounced. All setState happens inside the delayed callback —
  // never synchronously in the effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      let value: bigint;
      try {
        value = parseEther(monInput || "0");
      } catch {
        if (!cancelled) setQuote(null);
        return;
      }
      if (value <= 0n) {
        if (!cancelled) setQuote(null);
        return;
      }
      // Kuru first, desk second. Both are quoted the same way — ask, and use
      // whichever answers — so the fallback is exercised by any Kuru failure
      // rather than by a health check that can itself be wrong.
      void (async () => {
        if (address) {
          try {
            const token = await kuruToken(address);
            const leg1 = await kuruQuote({
              token,
              userAddress: address,
              tokenIn: "0x0000000000000000000000000000000000000000",
              tokenOut: USDC,
              amount: value,
            });
            // Kuru is taken whichever venue it picks, because its price beats
            // the desk's 1% either way. What changes is only what this page is
            // allowed to SAY: the route is chosen per quote and measured here
            // — 6 of 7 sizes sampled on mainnet crossed the order book, and
            // 10 MON went to a pool because the pool priced better at that
            // size. Falling back to the desk on that would charge the hunter
            // 1% to protect a claim, which is backwards.
            const leg2 = await kuruQuote({
              token,
              userAddress: address,
              tokenIn: USDC,
              tokenOut: AUSD_TOKEN,
              amount: leg1.output,
            });
            if (!cancelled) {
              setQuote(leg2.output);
              setRoute(leg1.usesOrderBook ? "kuru-book" : "kuru-pool");
            }
            return;
          } catch {
            // Fall through to the desk. Kuru being down is not an error the
            // hunter needs to read about; it is why the desk exists.
          }
        }
        try {
          const q = (await publicClient().readContract({
            address: SWAP_ADDRESS,
            abi: SWAP_ABI,
            functionName: "quote",
            args: [value],
          })) as bigint;
          if (!cancelled) {
            setQuote(q);
            setRoute("desk");
          }
        } catch {
          if (!cancelled) setQuote(null);
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [monInput, address]);

  const doSwap = useCallback(async () => {
    setError(null);
    let value: bigint;
    try {
      value = parseEther(monInput || "0");
    } catch {
      setError(t.tooLittle);
      return;
    }
    if (value <= 0n) {
      setError(t.tooLittle);
      return;
    }
    setPhase("swapping");
    try {
      if (route !== "desk") {
        const { account } = await signInAccount();
        const r = await swapMonToAusdViaKuru({
          account,
          monWei: value,
          onStep: setStep,
        });
        setBookTx(r.bookTxHash);
        setTxHash(r.convertTxHash);
        setAusdOut(r.ausdOut);
        setPhase("done");
        setStep(null);
        void refreshBalances();
        return;
      }
      const pc = publicClient();
      // Re-quote at execution time so the slippage floor is honest.
      const q = (await pc.readContract({
        address: SWAP_ADDRESS,
        abi: SWAP_ABI,
        functionName: "quote",
        args: [value],
      })) as bigint;
      const { account } = await signInAccount();
      // Simulate BEFORE spending gas: this reverts with the real reason (rate
      // stale, desk empty, not enough MON…) so explainSwapError can name it,
      // instead of the tx silently reverting on-chain.
      await pc.simulateContract({
        account: account.address,
        address: SWAP_ADDRESS,
        abi: SWAP_ABI,
        functionName: "swap",
        args: [minOut(q)],
        value,
      });
      const hash = await walletClientFor(account).writeContract({
        address: SWAP_ADDRESS,
        abi: SWAP_ABI,
        functionName: "swap",
        args: [minOut(q)],
        value,
      });
      setTxHash(hash);
      const receipt = await pc.waitForTransactionReceipt({ hash });
      // A mined tx can still be reverted — never claim success on that.
      if (receipt.status !== "success") {
        setError(t.reverted);
        setPhase("error");
        return;
      }
      setAusdOut(q);
      setPhase("done");
      void refreshBalances();
    } catch (e) {
      setError(explainSwapError(e, lang));
      setPhase("error");
      // Otherwise a failure at leg 3 leaves "2/3 Approving USDC…" on screen
      // next to an error, which reads as the app still working.
      setStep(null);
    }
  }, [monInput, lang, t.tooLittle, t.reverted, refreshBalances, route]);

  const deskLow = quote !== null && available !== null && quote > available;
  const noMon = monBalance !== null && monBalance === 0n;
  // Cap the amount so a hunter always keeps MON for gas (see GAS_RESERVE).
  const maxSwap =
    monBalance !== null && monBalance > GAS_RESERVE
      ? monBalance - GAS_RESERVE
      : 0n;
  let overMax = false;
  try {
    overMax = monInput.trim() !== "" && parseEther(monInput) > maxSwap;
  } catch {
    overMax = false;
  }

  return (
    <main className="safe-top safe-bottom text-ink mx-auto flex min-h-dvh max-w-md flex-col gap-4 px-4 py-6">
      <a href="/cota" className="text-ink-dim w-fit text-sm hover:underline">
        ← {t.back}
      </a>
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t.title}</h1>
          <p className="text-ink-dim mt-1 text-sm">{t.lede}</p>
        </div>
        <LanguageSwitch className="shrink-0" />
      </header>

      {auth.status !== "signed-in" ? (
        <Panel className="space-y-3">
          <SignInPrompt label={t.signIn} />
        </Panel>
      ) : (
        <>
          <Panel className="space-y-2">
            <p className="text-ink-dim text-xs tracking-wide uppercase">
              {t.wallet}
            </p>
            <p className="text-ink font-mono text-[13px] break-all">
              {address}
            </p>
            <p className="text-ink-faint text-xs">{t.fund}</p>
            <div className="text-ink flex justify-between pt-1 text-sm">
              <span className="text-ink-dim">{t.monBal}</span>
              <span className="font-mono">
                {monBalance === null ? "…" : formatEther(monBalance)} MON
              </span>
            </div>
            <div className="text-ink flex justify-between text-sm">
              <span className="text-ink-dim">{t.deskHas}</span>
              <span className="font-mono">
                {available === null ? "…" : formatAusd(available)} AUSD
              </span>
            </div>
          </Panel>

          {phase === "done" && ausdOut !== null ? (
            <Panel className="space-y-3">
              <Pill color="#4ade80">
                {t.done} {formatAusd(ausdOut)} AUSD
              </Pill>
              <p className="text-ink-dim text-sm">{t.next}</p>
              {/* Two links on the Kuru route, because they are two different
                  facts: one is the trade that executed on Kuru's order book,
                  the other is the conversion. A hunter who wants to check the
                  claim on this page can check it. */}
              {bookTx && (
                <a
                  href={`https://monadscan.com/tx/${bookTx}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-phosphor block text-sm underline"
                >
                  {t.viewBookTx} →
                </a>
              )}
              {txHash && (
                <a
                  href={`https://monadscan.com/tx/${txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-phosphor block text-sm underline"
                >
                  {t.viewTx} →
                </a>
              )}
              <a
                href="/cota/deposit"
                className="bg-phosphor text-void flex min-h-12 w-full items-center justify-center rounded-2xl px-5 text-sm font-semibold"
              >
                {t.goTrade}
              </a>
              <Button
                tone="ghost"
                onClick={() => {
                  setPhase("idle");
                  setMonInput("");
                  setAusdOut(null);
                  setTxHash(null);
                }}
              >
                ↺
              </Button>
            </Panel>
          ) : (
            <Panel className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-ink-dim block text-xs tracking-wide uppercase">
                  {t.amount}
                </label>
                {maxSwap > 0n && (
                  <button
                    type="button"
                    onClick={() => setMonInput(formatEther(maxSwap))}
                    className="text-phosphor text-xs font-semibold"
                  >
                    {t.max}
                  </button>
                )}
              </div>
              <input
                inputMode="decimal"
                value={monInput}
                onChange={(e) =>
                  setMonInput(e.target.value.replace(/[^0-9.]/g, ""))
                }
                placeholder="0.0"
                className="border-hull-line text-ink w-full rounded-xl border-2 bg-transparent px-4 py-3 font-mono text-lg outline-none"
              />
              <div className="text-ink flex items-baseline justify-between">
                <span className="text-ink-dim text-sm">{t.youGet}</span>
                <span className="font-mono text-lg">
                  {quote === null ? "—" : formatAusd(quote)} AUSD
                </span>
              </div>
              {/* Which venue this quote came from, and what it costs the
                  hunter in signatures. Three prompts with no explanation is how
                  someone abandons halfway and is left holding USDC. */}
              <div className="flex items-center gap-2">
                <Pill color={route === "desk" ? "#47645d" : "#46ffbe"}>
                  {route === "kuru-book"
                    ? t.viaBook
                    : route === "kuru-pool"
                      ? t.viaPool
                      : t.viaDesk}
                </Pill>
              </div>
              <p className="text-ink-faint text-xs leading-snug">
                {route === "kuru-book"
                  ? t.bookNote
                  : route === "kuru-pool"
                    ? t.poolNote
                    : t.deskNote}
              </p>
              {/* The desk float only constrains the DESK route. Warning about
                  it while Kuru is quoting would be false — Kuru has no float. */}
              {route === "desk" && deskLow && (
                <Note tone="warn">{t.deskLow}</Note>
              )}
              {noMon && <Note tone="warn">{t.noMon}</Note>}
              {overMax && <Note tone="warn">{t.overMax}</Note>}
              {error && <Note tone="warn">{error}</Note>}
              <p className="text-ink-faint text-xs">{t.keepGas}</p>
              <Button
                onClick={() => {
                  void doSwap();
                }}
                disabled={
                  phase === "swapping" ||
                  quote === null ||
                  (route === "desk" && deskLow) ||
                  noMon ||
                  overMax
                }
              >
                {phase !== "swapping"
                  ? t.swap
                  : step === "trading-on-book"
                    ? t.stepBook
                    : step === "approving"
                      ? t.stepApprove
                      : step === "converting"
                        ? t.stepConvert
                        : t.swapping}
              </Button>
            </Panel>
          )}
        </>
      )}
    </main>
  );
}
