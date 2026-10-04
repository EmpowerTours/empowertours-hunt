"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Disclosure, Note, Panel } from "@/components/ui/primitives";
import { SignInPrompt } from "@/components/auth/SignInPrompt";
import { useAuthSlot } from "@/app/providers";
import { signInAccount } from "@/lib/auth/passkey";
import { publicClient } from "@/lib/cota/swap";
import { AUSD_ABI, AUSD_ADDRESS, MIN_DEPOSIT_6DP } from "@/lib/cota/deposit";
import {
  ausdLabel,
  monLabel,
  planOneClick,
  type Balances,
  type OneClick,
  type Step,
} from "@/lib/cota/oneclick";
import {
  runPlan,
  strandedAfter,
  type RunResult,
} from "@/lib/cota/oneclick-run";
import { buildRunners, type Carry } from "@/lib/cota/oneclick-steps";

// ---------------------------------------------------------------------------
// The one control on the Cota hub.
//
// The hub had eleven buttons — swap, bridge, swap USDC, on-ramp, deposit,
// trade, risk, results, leaderboard, spot, enrol. Every one is a real step
// somebody has to take, in roughly that order, and together they ask a hunter
// who has just walked to a cache to work out which four apply to them. Eleven
// correct buttons are worse than one.
//
// WHAT IT MOSTLY DOES IS SAY NO, HONESTLY. Perpl will not accept a deposit
// under ten dollars — min_deposit_amount and min_account_open_amount are both
// 10000000 at six decimals in their own published context — and a spawn is one
// MON, about three and a half cents. So the usual answer is "you are 295 MON
// short", and the usual job of this panel is to say that with a number and a
// progress bar instead of offering a button that fails on tap.
//
// It never guesses a balance. Wallet MON and AUSD are read from the chain,
// collateral from Perpl, and the price from the live book. A panel that
// estimated any of them could tell a hunter they were ready when they were not,
// and they would find out by spending gas.
// ---------------------------------------------------------------------------

type Lang = "es" | "en";

const T = {
  es: {
    title: "Poner mi MON a trabajar",
    lede: "Un botón: cambia tu MON por AUSD en el libro de Kuru, lo deposita en Perpl y abre la operación bajo tu correa.",
    signIn: "Inicia sesión",
    checking: "Revisando tus saldos…",
    loadFailed: "No pudimos leer tus saldos",
    noPrice: "No se pudo leer el precio de MON ahora mismo.",
    retry: "Reintentar",
    short: "Te falta para empezar",
    shortNote:
      "Perpl no acepta depósitos menores a 10 USD. No es nuestra regla, es la suya.",
    have: "Tienes",
    need: "Necesitas",
    keepHunting: "Seguir cazando MON →",
    ready: "Invertir",
    willDo: "Al presionar:",
    stepSwap: "cambiar MON por AUSD en el libro de Kuru",
    stepDeposit: "depositar el AUSD en Perpl",
    stepLeash: "firmar tu correa (tú decides los límites)",
    stepTrade: "abrir la operación",
    working: "Trabajando…",
    notEnrolled: "Primero necesitas una llave de operación.",
    enrol: "Crear mi llave →",
    failed: "No se pudo completar",
    advanced: "Ajustes avanzados",
    howMuch: "¿Cuánto de tu MON?",
    whichWay: "¿Hacia dónde?",
    all: "Todo",
    pctNone: "Solo lo mínimo que exige Perpl. Tu MON se queda donde está.",
    pctOf: "≈ {mon} MON de tu cartera.",
    dirUp: "Largo",
    dirDown: "Corto",
    dirUpSub: "ganas si MON sube",
    dirDownSub: "ganas si MON baja",
    reqTitle: "Lo que necesitas para empezar",
    reqNote:
      "Perpl no acepta depósitos menores a 10 USD. Hoy eso son unos {mon} MON en tu cartera. No es nuestra regla, es la suya — y es lo mismo para cualquier cazador nuevo.",
    riskShort:
      "Dinero real, con apalancamiento. Puedes perder lo que depositas.",
    monIdle:
      "Tu MON se queda en tu cartera: Perpl no acepta depósitos menores a 10 USD y lo tuyo vale menos que eso.",
    riskTitle: "Esto es dinero real y puedes perderlo",
    riskBody:
      "Operas con apalancamiento en Perpl. Si el precio se mueve fuerte en tu contra, Perpl liquida la posición y pierdes el colateral que depositaste.",
    riskLeash:
      "Tu correa limita lo que el agente puede ABRIR — apalancamiento, tamaño, pérdida diaria. No cierra una posición por ti y no detiene al mercado.",
    riskNoLiq:
      "No te mostramos un precio de liquidación a propósito: Perpl documenta sus márgenes en unidades que se contradicen, y un número sacado de la unidad equivocada te diría que estás más seguro de lo que estás.",
    doneTitle: "Listo",
    doneBody:
      "Tu operación está abierta bajo tu correa. Puedes verla y cerrarla cuando quieras en Resultados.",
    tooSmallTitle: "Tu correa permite menos de lo mínimo",
    tooSmallBody:
      "El mercado no llena órdenes menores a 3 USD. Sube el tope de tamaño de tu correa en los ajustes avanzados y vuelve aquí.",
  },
  en: {
    title: "Put my MON to work",
    lede: "One button: sells your MON for AUSD on Kuru's order book, deposits it at Perpl, and opens the trade under your leash.",
    signIn: "Sign in",
    checking: "Checking your balances…",
    loadFailed: "We could not read your balances",
    noPrice: "Could not read the MON price just now.",
    retry: "Try again",
    short: "Not enough yet",
    shortNote:
      "Perpl refuses deposits under $10. That is their rule, not ours.",
    have: "You have",
    need: "You need",
    keepHunting: "Go hunt more MON →",
    ready: "Invest",
    willDo: "One press will:",
    stepSwap: "sell MON for AUSD on Kuru's order book",
    stepDeposit: "deposit the AUSD at Perpl",
    stepLeash: "sign your leash (you set the limits)",
    stepTrade: "open the trade",
    working: "Working…",
    notEnrolled: "You need a trading key first.",
    enrol: "Create my key →",
    failed: "Could not finish",
    advanced: "Advanced settings",
    howMuch: "How much of your MON?",
    whichWay: "Which way?",
    all: "All",
    pctNone: "Only the minimum Perpl requires. Your MON stays where it is.",
    pctOf: "≈ {mon} MON from your wallet.",
    dirUp: "Long",
    dirDown: "Short",
    dirUpSub: "you gain if MON rises",
    dirDownSub: "you gain if MON falls",
    reqTitle: "What you need to start",
    reqNote:
      "Perpl refuses deposits under $10. Today that is about {mon} MON in your wallet. That is their rule, not ours — and it is the same for every new hunter.",
    riskShort: "Real money, with leverage. You can lose what you deposit.",
    monIdle:
      "Your MON stays in your wallet: Perpl refuses deposits under $10 and yours is worth less than that.",
    riskTitle: "This is real money and you can lose it",
    riskBody:
      "You are trading with leverage on Perpl. If the price moves hard against you, Perpl liquidates the position and the collateral you deposited is gone.",
    riskLeash:
      "Your leash limits what the agent may OPEN — leverage, size, daily loss. It does not close a position for you and it cannot stop the market.",
    riskNoLiq:
      "We deliberately do not show you a liquidation price: Perpl documents its margin figures in contradictory units, and a number taken from the wrong one would tell you that you are safer than you are.",
    doneTitle: "Done",
    doneBody:
      "Your trade is open under your leash. You can watch it and close it any time from Results.",
    tooSmallTitle: "Your leash allows less than the minimum",
    tooSmallBody:
      "The market will not fill an order under $3. Raise your leash's size ceiling in advanced settings and come back.",
  },
} as const;

/**
 * MON held back for gas, derived from the live base fee rather than guessed.
 *
 * A flat reserve is the same mistake as a flat gas limit: wrong the moment the
 * route or the base fee moves, and on Monad the whole limit is charged whether
 * it is used or not, so being wrong is paid for in full. Four transactions at a
 * generous limit, priced at the fee the chain is quoting right now.
 */
const GAS_UNITS_WHOLE_FLOW = 1_600_000n;

/**
 * The smallest order Perpl will actually fill, 6dp.
 *
 * Chain-verified on MON: a $1 market order filled 0 and came back
 * TakerOrderSettlementFailed; a $3 one filled fully. Below this an order does
 * not trade small, it fails — and the worst moment to discover that is after
 * three irreversible steps have already moved the money.
 */
const MIN_FILLABLE_6DP = 3_000_000n;

/**
 * The leash a one-click press signs, and the order it then places.
 *
 * ONE TIMES LEVERAGE, deliberately, and not the 2x the leash permits. The
 * ceiling is what the hunter authorises; the order is what this button actually
 * sends, and they do not have to be the same number. At 1x a liquidation needs
 * the price to go to roughly nothing, which turns the risk disclosed above from
 * a live hazard into a remote one for the person who pressed a button they did
 * not fully understand. Advanced settings are where someone who does understand
 * raises it.
 */
const ONE_CLICK = {
  venue: "perpl" as const,
  markets: ["MON"] as const,
  maxNotionalUsdE6: 50_000_000n,
  maxLeverageX100: 200n,
  maxDailyLossUsdE6: 10_000_000n,
  maxTradesPerDay: 5,
  durationSeconds: 30n * 24n * 60n * 60n,
  market: "MON",
  side: "long" as const,
  leverageX: 1,
};

export function OneClickPanel({ lang }: { lang: Lang }) {
  const t = T[lang];
  const auth = useAuthSlot();

  const [plan, setPlan] = useState<OneClick | null>(null);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<Step | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  /** The digest of an already-live leash, when there is one to trade under. */
  const [liveDigest, setLiveDigest] = useState<string | null>(null);
  /** Share of wallet MON to deploy. null = only what the venue's floor needs. */
  const [pct, setPct] = useState<number | null>(null);
  const [side, setSide] = useState<"long" | "short">("long");

  const load = useCallback(async () => {
    if (auth.status !== "signed-in") return;
    const address = auth.walletAddress as `0x${string}` | null;
    if (!address) return;
    try {
      const pub = publicClient();
      // READ-ONLY, so no passkey ceremony. The address is already in the
      // session; signInAccount() derives the signing KEY, which reading two
      // balances does not need. Calling it here put a WebAuthn ceremony in
      // front of every page load — the "it takes a while" — and, worse, any
      // failure in it left the panel on "checking your balances" with no error
      // and no retry, because the loading branch returns before the failure
      // notice can render. The key is fetched when the button is pressed,
      // which is the moment a signature is actually needed.

      const [monWei, ausd6, accountRes, quoteRes, cotaRes, fee] =
        await Promise.all([
          pub.getBalance({ address }),
          pub.readContract({
            address: AUSD_ADDRESS,
            abi: AUSD_ABI,
            functionName: "balanceOf",
            args: [address],
          }) as Promise<bigint>,
          fetch("/api/cota/account", { cache: "no-store" }).then((r) =>
            r.ok ? r.json() : null,
          ),
          fetch("/api/cota/quote?market=MON", { cache: "no-store" }).then(
            (r) => (r.ok ? r.json() : null),
          ),
          fetch("/api/cota", { cache: "no-store" }).then((r) =>
            r.ok ? r.json() : null,
          ),
          pub.getGasPrice(),
        ]);

      // A missing price is not a reason to guess one. Without it there is no
      // honest way to say how much MON a ten dollar deposit costs, so the panel
      // stays in its loading state rather than inventing a number.
      const monUsd = quoteRes?.askUsd ?? quoteRes?.markUsd ?? null;
      if (typeof monUsd !== "number" || !(monUsd > 0)) {
        // No price, no honest answer about how much MON a $10 deposit costs.
        // Said out loud rather than returned silently: a bare `return` here
        // left the panel on "checking your balances" for as long as the page
        // stayed open, which is indistinguishable from the app being broken.
        setFailed(t.noPrice);
        return;
      }

      const now = Date.now();
      // IT MUST NAME THE MARKET WE INTEND TO TRADE. Taking the newest live
      // leash of any market is wrong and was only working by luck: this wallet
      // holds 17 live leashes, most of them BTC and PUMP, and whichever was
      // signed last would have been handed to a MON order. enforce.ts would
      // then refuse it for naming a market the Cota does not cover — the
      // correct refusal, arriving after the money had already moved.
      const live = (cotaRes?.cotas ?? []).find(
        (c: {
          revokedAt: string | null;
          notAfter: string;
          markets: string[];
        }) =>
          c.revokedAt === null &&
          new Date(c.notAfter).getTime() > now &&
          (c.markets ?? []).includes(ONE_CLICK.market),
      ) as { digest: string; maxNotionalUsdE6: string } | undefined;
      const hasLeash = Boolean(live);
      setLiveDigest(live?.digest ?? null);

      const b: Balances = {
        walletMonWei: monWei,
        walletAusd6: ausd6,
        perplAusd6: BigInt(
          Math.round((accountRes?.account?.balanceUsd ?? 0) * 1e6),
        ),
      };
      setBalances(b);
      setPlan(
        planOneClick(b, {
          enrolled: Boolean(accountRes?.enrolled),
          hasLeash,
          monUsd,
          minDeposit6: MIN_DEPOSIT_6DP,
          // NOT the deposit floor. Perpl publishes min_deposit_amount and
          // min_account_open_amount, both $10 — those govern getting AUSD IN.
          // Neither is a minimum balance required to trade, and nothing in
          // their context publishes one. Using $10 here meant a hunter holding
          // $5 of collateral was told to deposit another $10 before they could
          // trade at all, when the only floor their order actually faces is the
          // venue's fill minimum.
          minTrade6: MIN_FILLABLE_6DP,
          // The order has to fit under whichever leash governs it — the live
          // one, or the one this press would sign.
          leashMaxNotional6: live ? BigInt(live.maxNotionalUsdE6) : null,
          oneClickNotional6: ONE_CLICK.maxNotionalUsdE6,
          minFillable6: MIN_FILLABLE_6DP,
          targetMonWei: pct === null ? null : (monWei * BigInt(pct)) / 100n,
          gasReserveWei: GAS_UNITS_WHOLE_FLOW * fee,
          slippageBps: 100n,
        }),
      );
    } catch (err) {
      setFailed(String((err as { message?: string })?.message ?? err));
    }
  }, [auth.status, auth.walletAddress, pct]);

  useEffect(() => {
    void load();
  }, [load]);

  if (auth.status !== "signed-in") {
    return (
      <Panel className="space-y-3" noTranslate>
        <h2 className="text-ink text-lg font-semibold">{t.title}</h2>
        <p className="text-ink-dim text-sm">{t.lede}</p>
        <SignInPrompt label={t.signIn} />
      </Panel>
    );
  }

  if (plan === null || balances === null) {
    return (
      <Panel className="space-y-3" noTranslate>
        <p className="text-ink-dim text-sm">
          {failed ? t.loadFailed : t.checking}
        </p>
        {failed && (
          <>
            <p className="text-ink-faint text-[11px] break-words">{failed}</p>
            <Button
              onClick={() => {
                setFailed(null);
                void load();
              }}
            >
              {t.retry}
            </Button>
          </>
        )}
      </Panel>
    );
  }

  if (!plan.ok && plan.reason === "not_enrolled") {
    return (
      <Panel className="space-y-3" noTranslate>
        <h2 className="text-ink text-lg font-semibold">{t.title}</h2>
        <p className="text-ink-dim text-sm">{t.notEnrolled}</p>
        <a
          href="/cota/enroll"
          className="border-hull-line text-ink flex min-h-12 w-full items-center justify-center rounded-2xl border px-5 text-sm font-medium"
        >
          {t.enrol}
        </a>
      </Panel>
    );
  }

  if (!plan.ok && plan.reason === "below_min_order") {
    return (
      <Panel className="space-y-3" noTranslate>
        <h2 className="text-ink text-lg font-semibold">{t.title}</h2>
        <Note tone="warn" title={t.tooSmallTitle}>
          {t.tooSmallBody}
        </Note>
      </Panel>
    );
  }

  if (!plan.ok) {
    const pct =
      plan.needMonWei > 0n
        ? Number((plan.haveMonWei * 100n) / plan.needMonWei)
        : 0;
    return (
      <Panel className="space-y-3" noTranslate>
        <h2 className="text-ink text-lg font-semibold">{t.title}</h2>
        <div>
          <p className="text-ink text-sm font-semibold">{t.short}</p>
          <p className="text-ink-faint mt-1 text-xs">{t.shortNote}</p>
        </div>
        {/* The number, not a vague "not yet". A hunter deciding whether to walk
            another hour deserves to know it is 295 MON and not 3. */}
        <div className="border-hull-line bg-hull-2/40 rounded-xl border p-3">
          <div className="text-ink-dim flex justify-between font-mono text-xs">
            <span>{t.have}</span>
            <span className="text-ink" translate="no">
              {monLabel(plan.haveMonWei)} MON
            </span>
          </div>
          <div className="text-ink-dim mt-1 flex justify-between font-mono text-xs">
            <span>{t.need}</span>
            <span className="text-spawn" translate="no">
              {monLabel(plan.needMonWei)} MON
            </span>
          </div>
          <div className="bg-hull-line mt-2 h-1.5 w-full overflow-hidden rounded-full">
            <div
              className="bg-spawn h-full rounded-full"
              style={{ width: `${Math.max(1, Math.min(100, pct))}%` }}
            />
          </div>
        </div>
        <a
          href="/hunt"
          className="border-hull-line text-ink flex min-h-12 w-full items-center justify-center rounded-2xl border px-5 text-sm font-medium"
        >
          {t.keepHunting}
        </a>
        {/* Stated as a requirement, not just as today's gap. A hunter deciding
            whether this is worth walking for needs the entry price of the whole
            mechanic, not only how far off they happen to be this minute. */}
        <p className="text-ink-faint text-[11px] leading-snug">
          {t.reqNote.replace("{mon}", monLabel(plan.needMonWei))}
        </p>
      </Panel>
    );
  }

  const label: Record<string, string> = {
    swap: t.stepSwap,
    deposit: t.stepDeposit,
    leash: t.stepLeash,
    trade: t.stepTrade,
  };

  return (
    <Panel className="space-y-3" noTranslate>
      <div>
        <h2 className="text-ink text-lg font-semibold">{t.title}</h2>
        <p className="text-ink-faint mt-1 text-xs">{t.lede}</p>
      </div>

      {/* HOW MUCH, and WHICH WAY. Both were decided for the hunter before: the
          amount by whatever the venue's floor happened to be, and the direction
          by a constant that only ever said long. Neither is a choice this code
          is in a position to make — one is their money and the other is their
          opinion about the price. */}
      <div>
        <p className="text-ink-dim text-xs tracking-wide uppercase">
          {t.howMuch}
        </p>
        <div className="mt-1.5 grid grid-cols-4 gap-2">
          {([5, 30, 80, 100] as const).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setPct(pct === n ? null : n)}
              className={`min-h-11 rounded-xl border-2 font-mono text-sm ${
                pct === n
                  ? "border-phosphor text-phosphor"
                  : "border-hull-line text-ink-dim"
              }`}
            >
              {n === 100 ? t.all : `${n}%`}
            </button>
          ))}
        </div>
        <p className="text-ink-faint mt-1 text-[11px]">
          {pct === null
            ? t.pctNone
            : t.pctOf.replace(
                "{mon}",
                monLabel((balances.walletMonWei * BigInt(pct)) / 100n),
              )}
        </p>
      </div>

      <div>
        <p className="text-ink-dim text-xs tracking-wide uppercase">
          {t.whichWay}
        </p>
        <div className="mt-1.5 grid grid-cols-2 gap-2">
          {(["long", "short"] as const).map((sd) => (
            <button
              key={sd}
              type="button"
              onClick={() => setSide(sd)}
              className={`min-h-12 rounded-xl border-2 px-2 text-sm font-semibold ${
                side === sd
                  ? "border-phosphor text-phosphor"
                  : "border-hull-line text-ink-dim"
              }`}
            >
              {sd === "long" ? t.dirUp : t.dirDown}
              <span className="mt-0.5 block text-[11px] font-normal opacity-70">
                {sd === "long" ? t.dirUpSub : t.dirDownSub}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* What the press will do, BEFORE it is pressed. Three of these four
          steps move money and none can be undone, so the sequence is spelled
          out rather than hidden behind a verb. */}
      <div className="border-hull-line bg-hull-2/40 rounded-xl border p-3">
        <p className="text-ink-dim font-mono text-[11px] tracking-[0.18em] uppercase">
          {t.willDo}
        </p>
        <ol className="text-ink-dim mt-2 space-y-1 text-xs">
          {plan.steps.map((s, i) => (
            <li key={s}>
              {i + 1}. {label[s]}
            </li>
          ))}
        </ol>
      </div>

      {/* ONE LINE STAYS VISIBLE; the rest folds away.
          The screen was too busy and the detail was pushing the button down the
          page. But the material fact does not move behind a disclosure: a loss
          someone discovers by pressing is one they never agreed to. So the
          sentence that could change their mind is always on screen, and the
          reasoning behind it is one tap away for anyone who wants it. */}
      {/* Why the MON is staying put, when it is.
          The button says "put my MON to work" and a hunter holding MON that it
          is not touching deserves the reason unprompted — otherwise the label
          looks like a lie. It is Perpl's floor: below ten dollars there is no
          deposit to make, not a smaller one. */}
      {balances.walletMonWei > 0n && plan.swapMonWei === 0n && (
        <p className="text-ink-faint text-[11px] leading-snug">{t.monIdle}</p>
      )}

      <p className="text-alert text-xs leading-snug">{t.riskShort}</p>

      <Button
        onClick={async () => {
          setBusy(true);
          setResult(null);
          try {
            // One unlock. Every signature below comes from this account
            // without prompting again, which is what makes one press one press.
            const { account } = await signInAccount();
            const carry: Carry = {
              // A hunter who already has a live leash trades under it rather
              // than signing a second one; the plan omits the leash step for
              // exactly that case, so the digest has to come from the live one.
              digest: liveDigest,
              wentThroughOrderBook: null,
            };
            const runners = buildRunners({
              account,
              plan,
              ceilings: ONE_CLICK,
              market: ONE_CLICK.market,
              side,
              // The collateral that will be there once the steps above have
              // run, not what is there now.
              notionalUsd: Number(plan.orderNotional6) / 1e6,
              leverageX: ONE_CLICK.leverageX,
              carry,
              onStep: (step) => setRunning(step),
            });
            const r = await runPlan(plan.steps, runners, (step, err) => {
              const msg = String((err as { message?: string })?.message ?? err);
              return `${step}: ${msg}`;
            });
            setResult(r);
            if (r.ok) await load();
          } catch (err) {
            setFailed(String((err as { message?: string })?.message ?? err));
          } finally {
            setRunning(null);
            setBusy(false);
          }
        }}
        disabled={busy}
      >
        {busy
          ? `${t.working}${running ? ` (${label[running]})` : ""}`
          : `${t.ready} $${ausdLabel(plan.orderNotional6)}`}
      </Button>

      {/* A partial run says where the money actually is. "Something went wrong"
          is not an acceptable sentence on a path that has already spent it. */}
      {result && !result.ok && (
        <Note tone="stop" title={t.failed}>
          <span className="block">
            {result.outcomes.find((o) => !o.ok)?.error ?? ""}
          </span>
          {strandedAfter(result, lang) && (
            <span className="mt-1 block">{strandedAfter(result, lang)}</span>
          )}
        </Note>
      )}
      {result?.ok && (
        <Note tone="success" title={t.doneTitle}>
          {t.doneBody}
        </Note>
      )}

      <Disclosure title={t.riskTitle}>
        <p className="text-ink-dim text-xs leading-snug">{t.riskBody}</p>
        <p className="text-ink-dim text-xs leading-snug">{t.riskLeash}</p>
        <p className="text-ink-faint text-[11px] leading-snug">{t.riskNoLiq}</p>
      </Disclosure>

      {failed && <Note tone="warn">{`${t.failed}: ${failed}`}</Note>}
    </Panel>
  );
}
