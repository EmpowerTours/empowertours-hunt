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
  },
} as const;

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
      const hash = await walletClientFor(account).writeContract({
        address: SWAP_ADDRESS,
        abi: SWAP_ABI,
        functionName: "swap",
        args: [minOut(q)],
        value,
      });
      await pc.waitForTransactionReceipt({ hash });
      setTxHash(hash);
      setAusdOut(q);
      setPhase("done");
      void refreshBalances();
    } catch (e) {
      setError(explainSwapError(e, lang));
      setPhase("error");
    }
  }, [monInput, lang, t.tooLittle, refreshBalances]);

  const deskLow = quote !== null && available !== null && quote > available;
  const noMon = monBalance !== null && monBalance === 0n;

  return (
    <main className="text-ink mx-auto flex min-h-dvh max-w-md flex-col gap-4 px-4 py-6">
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
              <label className="text-ink-dim block text-xs tracking-wide uppercase">
                {t.amount}
              </label>
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
              {error && <Note tone="warn">{error}</Note>}
              <Button
                onClick={() => {
                  void doSwap();
                }}
                disabled={
                  phase === "swapping" || quote === null || deskLow || noMon
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
