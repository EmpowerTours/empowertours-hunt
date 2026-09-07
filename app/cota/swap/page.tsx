"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { formatEther, parseEther } from "viem";
import { useAuthSlot } from "@/app/providers";
import { Button, Note, Panel, Pill } from "@/components/ui/primitives";
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

// ---------------------------------------------------------------------------
// MON -> AUSD. A hunter who only has MON turns it into AUSD here to fund a Perpl
// account. The MON leaves their Cota wallet (the passkey wallet), the AUSD lands
// in the same wallet. One Face ID per swap; the desk's staleness/slippage guards
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
    swapping: "Cambiando… firma con Face ID",
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
    goTrade: "Ir a operar en Cota →",
    keepGas: "Guarda algo de MON para el gas — no cambies todo tu saldo.",
    overMax: "Deja ~0.05 MON para el gas. Toca Máx.",
    max: "Máx",
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
    swapping: "Swapping… sign with Face ID",
    done: "Done! You received",
    deskLow: "The desk doesn't have enough AUSD for that right now.",
    tooLittle: "Enter an amount of MON.",
    noMon: "No MON in your Cota wallet. Send MON to the address above.",
    viewTx: "View transaction",
    next: "Now deposit the AUSD to Perpl and trade on Cota.",
    reverted:
      "The transaction reverted on-chain — check your MON balance and the price. Nothing was swapped.",
    back: "Cota",
    goTrade: "Go trade on Cota →",
    keepGas: "Keep some MON for gas — don't swap your whole balance.",
    overMax: "Leave ~0.05 MON for gas. Tap Max.",
    max: "Max",
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

  const address = auth.walletAddress;

  // Desk float + wallet MON balance.
  const refreshBalances = useCallback(async () => {
    try {
      const pc = publicClient();
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
    } catch {
      // reads can fail transiently; leave the last known values
    }
  }, [address]);

  useEffect(() => {
    void (async () => {
      await refreshBalances();
    })();
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
      void publicClient()
        .readContract({
          address: SWAP_ADDRESS,
          abi: SWAP_ABI,
          functionName: "quote",
          args: [value],
        })
        .then((q) => {
          if (!cancelled) setQuote(q as bigint);
        })
        .catch(() => {
          if (!cancelled) setQuote(null);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [monInput]);

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
    }
  }, [monInput, lang, t.tooLittle, t.reverted, refreshBalances]);

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
    <main className="text-ink mx-auto flex min-h-dvh max-w-md flex-col gap-4 px-4 py-6">
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
          <Button
            onClick={() => {
              void auth.signIn();
            }}
            disabled={!auth.canSignIn}
          >
            {t.signIn}
          </Button>
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
              {txHash && (
                <a
                  href={`https://monadscan.com/tx/${txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-phosphor text-sm underline"
                >
                  {t.viewTx} →
                </a>
              )}
              <a
                href="/cota"
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
              {deskLow && <Note tone="warn">{t.deskLow}</Note>}
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
                  deskLow ||
                  noMon ||
                  overMax
                }
              >
                {phase === "swapping" ? t.swapping : t.swap}
              </Button>
            </Panel>
          )}
        </>
      )}
    </main>
  );
}
