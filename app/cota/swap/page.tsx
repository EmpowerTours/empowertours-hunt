"use client";

import { useCallback, useEffect, useState } from "react";
import { trackFeature } from "@/components/analytics/track";
import { useLocale } from "next-intl";
import { formatEther, formatUnits, parseEther } from "viem";
import { useAuthSlot } from "@/app/providers";
import { Button, Note, Panel, Pill } from "@/components/ui/primitives";
import { SignInPrompt } from "@/components/auth/SignInPrompt";
import { LanguageSwitch } from "@/components/hunt/LanguageSwitch";
import { signInAccount } from "@/lib/auth/passkey";
import {
  formatAusd,
  publicClient,
  SWAP_ABI,
  SWAP_ADDRESS,
  swapGasReserveWei,
  explainSwapError,
  belowDeskMinimum,
  formatMonCeil,
  minMonForDesk,
  DeskReverted,
} from "@/lib/cota/swap";
import {
  chooseRoute,
  quoteAusdRoutes,
  swapMonToAusd,
  type AusdRoute,
} from "@/lib/cota/ausd-route";
import { V4Reverted } from "@/lib/cota/uniswap-v4";
import { AUSD as AUSD_TOKEN, shouldResumeUsdc, USDC } from "@/lib/cota/kuru";

const BAL_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

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
    deskMin: (mon: string) => `Mínimo para la caja: ${mon} MON.`,
    belowMin: (mon: string) =>
      `Es muy poco MON para la caja. Cambia al menos ${mon} MON.`,
    minUnknown:
      "No pudimos leer el mínimo de la caja. Intenta de nuevo en un momento.",
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
    resumeTitle: "Tienes USDC",
    resumeBody: (usdc: string) =>
      `Tienes ${usdc} USDC. Kuru ya no tiene un mercado de AUSD, así que para convertirlo: compra MON con ese USDC en Contado y luego cámbialo aquí por AUSD.`,
    resumeCta: "Comprar MON con mi USDC →",
    viaV4: "Vía el pool de Uniswap v4 (comisión 0.05%)",
    v4Note:
      "Se cambia en el pool MON/AUSD de Uniswap: una sola transacción, sin depender del AUSD de la caja.",
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
    deskMin: (mon: string) => `Desk minimum: ${mon} MON.`,
    belowMin: (mon: string) =>
      `That's too little MON for the desk. Swap at least ${mon} MON.`,
    minUnknown: "We couldn't read the desk minimum. Try again in a moment.",
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
    resumeTitle: "You hold USDC",
    resumeBody: (usdc: string) =>
      `You hold ${usdc} USDC. Kuru no longer has an AUSD market, so to convert it: buy MON with that USDC on Spot, then swap the MON for AUSD here.`,
    resumeCta: "Buy MON with my USDC →",
    viaV4: "Via the Uniswap v4 pool (0.05% fee)",
    v4Note:
      "Swaps in Uniswap's MON/AUSD pool: one transaction, without drawing on the desk's AUSD.",
    viaPool: "Via Kuru (routed through a pool)",
    poolNote:
      "Kuru routed this size through a pool rather than the order book, because the price there is better for you. Still three signatures.",
  },
} as const;

// Never swap the whole balance: a swap that leaves no MON for gas reverts
// underpriced (this is exactly what bit the first live test). Reserve this much
// MON for gas and cap the swap amount to it.
/**
 * Used only until the live gas price arrives. Sized for a high price rather
 * than today's: briefly offering slightly less than the maximum costs a hunter
 * nothing, while offering more than they can sign costs them the swap.
 */
const GAS_RESERVE_FALLBACK = parseEther("0.2");

export default function SwapPage() {
  const lang: Lang = useLocale() === "es" ? "es" : "en";
  const t = T[lang];
  const auth = useAuthSlot();

  const [monInput, setMonInput] = useState("");
  const [quote, setQuote] = useState<bigint | null>(null);
  // Which route the quote came from: the Uniswap v4 pool or our desk,
  // whichever pays more (lib/cota/ausd-route.ts decides, for here and one-click).
  const [route, setRoute] = useState<AusdRoute | null>(null);
  const [available, setAvailable] = useState<bigint | null>(null);
  const [monBalance, setMonBalance] = useState<bigint | null>(null);
  // Live, because the reserve is priced in MON and the price moves.
  const [gasPrice, setGasPrice] = useState<bigint | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [ausdOut, setAusdOut] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);
  // MON -> AUSD goes through the desk only. Kuru's relaunched exchange has no
  // AUSD market (all nine of its books quote USDC, 2026-10-31), and the old
  // two-leg Kuru route through ws.kuru.io no longer answers.
  const [usdcBalance, setUsdcBalance] = useState<bigint | null>(null);
  const [ausdBalance, setAusdBalance] = useState<bigint | null>(null);

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
          setGasPrice(await pc.getGasPrice());
          // Leg 1 may have landed and leg 2 not: USDC with no AUSD. Read both
          // so the screen can offer to finish rather than sell more MON.
          const [u, a] = await Promise.all(
            [USDC, AUSD_TOKEN].map(
              (token) =>
                pc.readContract({
                  address: token,
                  abi: BAL_ABI,
                  functionName: "balanceOf",
                  args: [address as `0x${string}`],
                }) as Promise<bigint>,
            ),
          );
          setUsdcBalance(u);
          setAusdBalance(a);
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

  // Desk minimum, from the desk's own live quote and minSwapAusd — never a
  // constant, because the MON that clears 1 AUSD moves with the MON price.
  // null + deskMinFailed = we could not read it, so say "try again" rather
  // than show a number we cannot vouch for.
  const [deskMinMon, setDeskMinMon] = useState<bigint | null>(null);
  const [deskMinFailed, setDeskMinFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const read = async () => {
      try {
        const pc = publicClient();
        const [min, perMon] = await Promise.all([
          pc.readContract({
            address: SWAP_ADDRESS,
            abi: SWAP_ABI,
            functionName: "minSwapAusd",
          }) as Promise<bigint>,
          pc.readContract({
            address: SWAP_ADDRESS,
            abi: SWAP_ABI,
            functionName: "quote",
            args: [10n ** 18n],
          }) as Promise<bigint>,
        ]);
        const m = minMonForDesk(min, perMon);
        if (live) {
          setDeskMinMon(m);
          setDeskMinFailed(m === null);
        }
      } catch {
        if (live) {
          setDeskMinMon(null);
          setDeskMinFailed(true);
        }
      }
    };
    void read();
    const id = setInterval(() => void read(), 60000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

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
      void (async () => {
        try {
          const choice = chooseRoute(await quoteAusdRoutes(value));
          if (!cancelled) {
            setQuote(choice?.ausdOut ?? null);
            setRoute(choice?.route ?? null);
          }
        } catch {
          if (!cancelled) {
            setQuote(null);
            setRoute(null);
          }
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
      const { account } = await signInAccount();
      const r = await swapMonToAusd(account, value, (_, h) => setTxHash(h));
      setRoute(r.route);
      setAusdOut(r.ausdOut);
      setPhase("done");
      trackFeature("swap_mon_to_ausd");
      void refreshBalances();
    } catch (e) {
      // A mined tx can still be reverted — never claim success on that.
      setError(
        e instanceof DeskReverted || e instanceof V4Reverted
          ? t.reverted
          : explainSwapError(e, lang, deskMinMon),
      );
      setPhase("error");
    }
  }, [monInput, lang, t.tooLittle, t.reverted, refreshBalances, deskMinMon]);

  const deskLow =
    route === "desk" && quote !== null && available !== null && quote > available;
  const noMon = monBalance !== null && monBalance === 0n;
  // Cap the amount so a hunter always keeps MON for gas. Derived from the
  // MEASURED cost of this swap and the live price rather than a flat constant:
  // the old 0.05 covered today's 102 gwei and stopped covering anything at
  // 171, with nothing to say so. See swapGasReserveWei.
  const gasReserve =
    gasPrice === null ? GAS_RESERVE_FALLBACK : swapGasReserveWei(gasPrice);
  const maxSwap =
    monBalance !== null && monBalance > gasReserve
      ? monBalance - gasReserve
      : 0n;
  let inputWei = 0n;
  try {
    inputWei = monInput.trim() === "" ? 0n : parseEther(monInput);
  } catch {
    inputWei = 0n;
  }
  // The desk's minimum only binds when the desk is the route.
  const belowMin =
    route === "desk" && inputWei > 0n && belowDeskMinimum(inputWei, deskMinMon);
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
          {shouldResumeUsdc(usdcBalance, ausdBalance) && usdcBalance !== null && (
            <Note tone="warn" title={t.resumeTitle}>
              <span className="block">
                {t.resumeBody(Number(formatUnits(usdcBalance, 6)).toFixed(2))}
              </span>
              <a
                href="/cota/spot"
                className="mt-2 block font-semibold underline"
              >
                {t.resumeCta}
              </a>
            </Note>
          )}
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
                {route !== null && (
                  <Pill color={route === "v4" ? "#46ffbe" : "#47645d"}>
                    {route === "v4" ? t.viaV4 : t.viaDesk}
                  </Pill>
                )}
              </div>
              <p className="text-ink-faint text-xs leading-snug">
                {route === "v4" ? t.v4Note : t.deskNote}
              </p>
              {deskLow && (
                <Note tone="warn">{t.deskLow}</Note>
              )}
              {route === "desk" && deskMinMon !== null && (
                <p className="text-ink-faint text-xs">
                  {t.deskMin(formatMonCeil(deskMinMon))}
                </p>
              )}
              {route === "desk" && deskMinFailed && (
                <Note tone="warn">{t.minUnknown}</Note>
              )}
              {belowMin && deskMinMon !== null && (
                <Note tone="warn">{t.belowMin(formatMonCeil(deskMinMon))}</Note>
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
                  deskLow ||
                  belowMin ||
                  noMon ||
                  overMax
                }
              >
                {phase !== "swapping" ? t.swap : t.swapping}
              </Button>
            </Panel>
          )}
        </>
      )}
    </main>
  );
}
