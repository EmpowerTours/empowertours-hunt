"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { useAuthSlot } from "@/app/providers";
import { Button, Note, Panel, Pill } from "@/components/ui/primitives";
import { SignInPrompt } from "@/components/auth/SignInPrompt";
import { LanguageSwitch } from "@/components/hunt/LanguageSwitch";
import { signInAccount } from "@/lib/auth/passkey";
import { formatAusd, publicClient } from "@/lib/cota/swap";
import {
  AUSD_ABI,
  AUSD_ADDRESS,
  explainDepositError,
  fundPerpl,
  MIN_DEPOSIT_6DP,
  parseAusd,
} from "@/lib/cota/deposit";
import {
  explainForwardingError,
  setOrderForwarding,
} from "@/lib/cota/forwarding";

// ---------------------------------------------------------------------------
// Deposit AUSD into a Perpl account. The step between the swap and enrolling a
// trading key: without an on-chain account, enrollment returns "profile not
// found" and no trade is possible. From the hunter's Mera wallet, one approve +
// one create/top-up. Minimum 10 AUSD (Perpl's own account-open floor).
//
// Then a third signature that is not about money at all: allowOrderForwarding.
// A Perpl account opens with order forwarding OFF, and with it off the gateway
// accepts every order and the chain refuses it — a silent non-fill with no
// error to read. It is what Perpl's own app calls "1-click trading", and it is
// an on-chain call from the account holder's wallet, so Hunt can send it here
// and no hunter has to find a setting in somebody else's web app. It is sent
// after the deposit, because with no account there is nothing to switch on.
// ---------------------------------------------------------------------------

type Lang = "es" | "en";
type Phase = "idle" | "funding" | "done" | "error";

const T = {
  es: {
    title: "Fondea tu cuenta Perpl",
    lede: "Deposita AUSD como colateral. Sin esto no puedes autorizar una clave ni operar. Mínimo 10 AUSD.",
    signIn: "Inicia sesión para depositar",
    wallet: "Tu billetera Cota",
    ausdBal: "AUSD disponible",
    amount: "AUSD a depositar",
    min: "Mínimo 10 AUSD para abrir la cuenta.",
    notEnough: "No tienes suficiente AUSD. Cambia más MON primero.",
    fund: "Depositar en Perpl",
    funding: "Depositando… confirma con tu passkey",
    created: "¡Cuenta Perpl abierta! Depositaste",
    deposited: "¡Depósito hecho! Agregaste",
    viewTx: "Ver transacción",
    next: "Ahora autoriza tu clave de trading.",
    goEnroll: "Autorizar clave →",
    swapFirst: "¿Sin AUSD? Cambia MON primero →",
    back: "Cota",
    max: "Máx",
    twoTx:
      "Son tres firmas: aprobar el AUSD, el depósito, y activar el trading en Perpl.",
    enabling: "Activando el trading en Perpl…",
    enabled: "Trading activado en Perpl (reenvío de órdenes).",
    enableFailed:
      "El depósito sí entró, pero falta activar el reenvío de órdenes. Sin esto, Perpl acepta la orden y la cadena la rechaza.",
    enableRetry: "Activar trading",
  },
  en: {
    title: "Fund your Perpl account",
    lede: "Deposit AUSD as collateral. Without this you can't authorize a key or trade. Minimum 10 AUSD.",
    signIn: "Sign in to deposit",
    wallet: "Your Cota wallet",
    ausdBal: "AUSD available",
    amount: "AUSD to deposit",
    min: "Minimum 10 AUSD to open the account.",
    notEnough: "Not enough AUSD. Swap more MON first.",
    fund: "Deposit to Perpl",
    funding: "Depositing… confirm with your passkey",
    created: "Perpl account opened! You deposited",
    deposited: "Deposit done! You added",
    viewTx: "View transaction",
    next: "Now authorize your trading key.",
    goEnroll: "Authorize key →",
    swapFirst: "No AUSD? Swap MON first →",
    back: "Cota",
    max: "Max",
    twoTx:
      "This is three signatures: approve the AUSD, the deposit, then switching trading on at Perpl.",
    enabling: "Switching trading on at Perpl…",
    enabled: "Trading is switched on at Perpl (order forwarding).",
    enableFailed:
      "The deposit went through, but order forwarding is still off. Until it is on, Perpl accepts an order and the chain rejects it.",
    enableRetry: "Switch trading on",
  },
} as const;

export default function DepositPage() {
  const lang: Lang = useLocale() === "es" ? "es" : "en";
  const t = T[lang];
  const auth = useAuthSlot();

  const [ausdInput, setAusdInput] = useState("10");
  const [ausdBalance, setAusdBalance] = useState<bigint | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [action, setAction] = useState<"create" | "deposit" | null>(null);
  const [amountDone, setAmountDone] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fwdPhase, setFwdPhase] = useState<
    "idle" | "sending" | "done" | "error"
  >("idle");
  const [fwdTx, setFwdTx] = useState<string | null>(null);
  const [fwdError, setFwdError] = useState<string | null>(null);

  const address = auth.walletAddress;

  const refreshBalance = useCallback(async () => {
    if (!address) return;
    const pc = publicClient();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const bal = (await pc.readContract({
          address: AUSD_ADDRESS,
          abi: AUSD_ABI,
          functionName: "balanceOf",
          args: [address as `0x${string}`],
        })) as bigint;
        setAusdBalance(bal);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }
  }, [address]);

  useEffect(() => {
    let live = true;
    const tick = () => {
      if (live) void refreshBalance();
    };
    tick();
    const id = setInterval(tick, 12000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [refreshBalance]);

  const amount = parseAusd(ausdInput);
  const belowMin = amount !== null && amount < MIN_DEPOSIT_6DP;
  const notEnough =
    amount !== null && ausdBalance !== null && amount > ausdBalance;

  const doDeposit = useCallback(async () => {
    setError(null);
    const amt = parseAusd(ausdInput);
    if (amt === null || amt < MIN_DEPOSIT_6DP) {
      setError(t.min);
      return;
    }
    setPhase("funding");
    try {
      const { account } = await signInAccount();
      const res = await fundPerpl(account, amt);
      setAction(res.action);
      setTxHash(res.txHash);
      setAmountDone(amt);
      setPhase("done");
      void refreshBalance();
      // The deposit has landed; the money is safe whatever happens next. A
      // failure here must therefore never present as a failed deposit — it is
      // reported on its own, with its own retry.
      setFwdPhase("sending");
      setFwdError(null);
      try {
        setFwdTx(await setOrderForwarding(account, true));
        setFwdPhase("done");
      } catch (e) {
        setFwdError(explainForwardingError(e, lang));
        setFwdPhase("error");
      }
    } catch (e) {
      setError(explainDepositError(e, lang));
      setPhase("error");
    }
  }, [ausdInput, lang, t.min, refreshBalance]);

  const retryForwarding = useCallback(async () => {
    setFwdPhase("sending");
    setFwdError(null);
    try {
      const { account } = await signInAccount();
      setFwdTx(await setOrderForwarding(account, true));
      setFwdPhase("done");
    } catch (e) {
      setFwdError(explainForwardingError(e, lang));
      setFwdPhase("error");
    }
  }, [lang]);

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
            <div className="text-ink flex justify-between pt-1 text-sm">
              <span className="text-ink-dim">{t.ausdBal}</span>
              <span className="font-mono">
                {ausdBalance === null ? "…" : formatAusd(ausdBalance)} AUSD
              </span>
            </div>
          </Panel>

          {phase === "done" && amountDone !== null ? (
            <Panel className="space-y-3">
              <Pill color="#4ade80">
                {action === "create" ? t.created : t.deposited}{" "}
                {formatAusd(amountDone)} AUSD
              </Pill>
              {fwdPhase === "sending" && (
                <p className="text-ink-dim text-sm">{t.enabling}</p>
              )}
              {fwdPhase === "done" && (
                <p className="text-ink-dim text-sm">
                  {t.enabled}
                  {fwdTx && (
                    <>
                      {" "}
                      <a
                        href={`https://monadscan.com/tx/${fwdTx}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-phosphor underline"
                      >
                        {t.viewTx} →
                      </a>
                    </>
                  )}
                </p>
              )}
              {fwdPhase === "error" && (
                <Note tone="warn">
                  {t.enableFailed}
                  {fwdError ? ` ${fwdError}` : ""}
                </Note>
              )}
              {fwdPhase === "error" && (
                <Button
                  onClick={() => {
                    void retryForwarding();
                  }}
                >
                  {t.enableRetry}
                </Button>
              )}
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
                href="/cota/enroll"
                className="bg-phosphor text-void flex min-h-12 w-full items-center justify-center rounded-2xl px-5 text-sm font-semibold"
              >
                {t.goEnroll}
              </a>
            </Panel>
          ) : (
            <Panel className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-ink-dim block text-xs tracking-wide uppercase">
                  {t.amount}
                </label>
                {ausdBalance !== null && ausdBalance >= MIN_DEPOSIT_6DP && (
                  <button
                    type="button"
                    onClick={() => setAusdInput(formatAusd(ausdBalance))}
                    className="text-phosphor text-xs font-semibold"
                  >
                    {t.max}
                  </button>
                )}
              </div>
              <input
                inputMode="decimal"
                value={ausdInput}
                onChange={(e) =>
                  setAusdInput(e.target.value.replace(/[^0-9.]/g, ""))
                }
                placeholder="10"
                className="border-hull-line text-ink w-full rounded-xl border-2 bg-transparent px-4 py-3 font-mono text-lg outline-none"
              />
              {belowMin && <Note tone="warn">{t.min}</Note>}
              {notEnough && (
                <Note tone="warn">
                  {t.notEnough}{" "}
                  <a href="/cota/swap" className="underline">
                    {t.swapFirst}
                  </a>
                </Note>
              )}
              {error && <Note tone="warn">{error}</Note>}
              <p className="text-ink-faint text-xs">{t.twoTx}</p>
              <Button
                onClick={() => {
                  void doDeposit();
                }}
                disabled={
                  phase === "funding" ||
                  amount === null ||
                  belowMin ||
                  notEnough
                }
              >
                {phase === "funding" ? t.funding : t.fund}
              </Button>
            </Panel>
          )}
        </>
      )}
    </main>
  );
}
