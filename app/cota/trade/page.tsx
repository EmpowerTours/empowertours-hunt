"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale } from "next-intl";
import { useAuthSlot } from "@/app/providers";
import { Button, Note, Panel, Pill } from "@/components/ui/primitives";
import { LanguageSwitch } from "@/components/hunt/LanguageSwitch";
import { signInAccount } from "@/lib/auth/passkey";
import { boundFromRow } from "@/lib/cota/bound";
import {
  explainForwardingError,
  setOrderForwarding,
} from "@/lib/cota/forwarding";
import { refusalText } from "@/lib/cota/denial-text";
import { mayOpen, type DayState, type ProposedOrder } from "@/lib/cota/enforce";
import { leverageX100, usdE6 } from "@/lib/cota/scale";

// ---------------------------------------------------------------------------
// The hunter-facing trade screen. Shows the signed leash, lets a hunter shape
// an order, and gives the leash's verdict live — the same enforce.ts that the
// server-side agent runs on every real order, so what a hunter sees here is
// what will actually be allowed. Execution (the agent placing the order) is the
// next piece; this is the product surface it plugs into.
// ---------------------------------------------------------------------------

type Lang = "es" | "en";

interface CotaRow {
  id: string;
  venue: string;
  markets: string[];
  maxNotionalUsdE6: string;
  maxLeverageX100: string;
  maxDailyLossUsdE6: string;
  maxTradesPerDay: number;
  notBefore: string;
  notAfter: string;
  digest: string;
  revokedAt: string | null;
  anchorTxHash: string | null;
}

const T = {
  es: {
    title: "Operar",
    lede: "Da forma a una orden. Tu correa firmada decide si se permite — al instante.",
    signIn: "Inicia sesión para operar",
    noCota: "Aún no tienes una correa activa.",
    goSign: "Firmar una correa →",
    leash: "Tu correa",
    market: "Mercado",
    side: "Lado",
    long: "Largo",
    short: "Corto",
    notional: "Tamaño (USD)",
    leverage: "Apalancamiento",
    allowed: "Dentro de tu correa ✓",
    verdict: "Veredicto de la correa",
    maxN: "Tamaño máx.",
    maxL: "Apalanc. máx.",
    dayLoss: "Pérdida diaria máx.",
    trades: "Operaciones/día",
    anchored: "Anclada",
    notAnchored: "sin anclar",
    place: "Colocar orden",
    placing: "Colocando…",
    placed: "¡Orden ejecutada! ✓",
    placeAccepted: "Aceptada (aún sin llenar)",
    placeFilledPending:
      "Ejecutada ✓ — Perpl confirmó la operación. El precio llega un instante después, así que se anota en tu registro en la próxima lectura.",
    placeRejected: "Tu correa rechazó esto",
    placeFailed: "Falló la colocación",
    fwdFix: "Activar trading en Perpl",
    fwdFixing: "Activando…",
    fwdFixed: "Trading activado. Vuelve a colocar la orden.",
    reconcile: "Adoptar la posición y continuar",
    reconciling: "Adoptando…",
    reconcileNote:
      "Tu cuenta tiene una posición que este agente no registró — normalmente porque se llenó después de que el socket que la colocó se cerró. Adoptarla la anota al precio de entrada de Perpl y reanuda el trading. La pérdida de hoy se cuenta desde esa entrada.",
    reconciled: "Posición adoptada. Vuelve a colocar la orden.",
    reconcileNothing:
      "No hubo nada que adoptar. Si el bloqueo sigue, la posición ya no existe en la casa y no hay precio honesto que registrar.",
    reconcileFailed: "No se pudo adoptar",
    posTitle: "Tu posición",
    posNone: "Sin posición abierta.",
    posSide: { long: "Largo", short: "Corto" },
    posEntry: "Entrada",
    posMark: "Precio",
    posPnl: "Sin realizar",
    closeAll: "Cerrar todo",
    closeHalf: "Cerrar la mitad",
    closing: "Cerrando…",
    closeAtLoss:
      "Esto realiza una pérdida. Cerrar siempre está permitido — la correa nunca te encierra — pero la pérdida se vuelve real al tocar.",
    closeDone: "Cerrada ✓",
    closeAccepted: "Aceptada — se anota en la próxima lectura.",
    closeFailed: "No se pudo cerrar",
    revoke: "Revocar esta Cota",
    revokeConfirm: "Confirmar: revocar",
    revokeCancel: "Cancelar",
    revokeNote:
      "Revocar detiene TODA orden nueva de inmediato y no se puede deshacer — para volver a operar tendrás que firmar una Cota nueva. Lo que ya esté abierto sigue abierto: qué hacer con esa posición lo decides tú.",
    revoking: "Revocando…",
    revoked: "Cota revocada. No se abrirá nada nuevo.",
    revokeFailed: "No se pudo revocar",
    suggest: "Sugerir con Kimi",
    suggesting: "Kimi pensando…",
    kimiHold: "Kimi sugiere esperar",
    proposerDown: "Kimi no está disponible ahora",
    freshNote:
      "Vista previa contra un día limpio (0 abierto, 0 perdido). El agente usa tu estado real al ejecutar.",
    back: "Cota",
  },
  en: {
    title: "Trade",
    lede: "Shape an order. Your signed leash decides if it's allowed — instantly.",
    signIn: "Sign in to trade",
    noCota: "You don't have an active leash yet.",
    goSign: "Sign a leash →",
    leash: "Your leash",
    market: "Market",
    side: "Side",
    long: "Long",
    short: "Short",
    notional: "Size (USD)",
    leverage: "Leverage",
    allowed: "Within your leash ✓",
    verdict: "Leash verdict",
    maxN: "Max size",
    maxL: "Max leverage",
    dayLoss: "Max daily loss",
    trades: "Trades/day",
    anchored: "Anchored",
    notAnchored: "not anchored",
    place: "Place order",
    placing: "Placing…",
    placed: "Order filled! ✓",
    placeAccepted: "Accepted (not filled yet)",
    placeFilledPending:
      "Filled ✓ — Perpl confirmed the trade. The price frame arrives a moment later, so it lands in your ledger on the next read.",
    placeRejected: "Your leash rejected this",
    placeFailed: "Placement failed",
    fwdFix: "Switch trading on at Perpl",
    fwdFixing: "Switching on…",
    fwdFixed: "Trading is on. Place the order again.",
    reconcile: "Adopt the position and continue",
    reconciling: "Adopting…",
    reconcileNote:
      "Your account holds a position this agent never recorded — usually because it filled after the socket that placed it closed. Adopting it records it at Perpl's own entry price and resumes trading. Today's loss is counted from that entry.",
    reconciled: "Position adopted. Place the order again.",
    reconcileNothing:
      "There was nothing to adopt. If it stays blocked, the venue no longer reports that position and there is no honest price to record.",
    reconcileFailed: "Could not adopt",
    posTitle: "Your position",
    posNone: "No open position.",
    posSide: { long: "Long", short: "Short" },
    posEntry: "Entry",
    posMark: "Mark",
    posPnl: "Unrealised",
    closeAll: "Close all",
    closeHalf: "Close half",
    closing: "Closing…",
    closeAtLoss:
      "This realises a loss. Closing is always allowed — the leash never locks you in — but the loss becomes real when you tap.",
    closeDone: "Closed ✓",
    closeAccepted: "Accepted — it lands in your ledger on the next read.",
    closeFailed: "Could not close",
    revoke: "Revoke this Cota",
    revokeConfirm: "Confirm: revoke",
    revokeCancel: "Cancel",
    revokeNote:
      "Revoking stops ALL new orders immediately and cannot be undone — you'd need to sign a new Cota to trade again. Anything already open stays open: what to do with that position is your call.",
    revoking: "Revoking…",
    revoked: "Cota revoked. Nothing new will open.",
    revokeFailed: "Could not revoke",
    suggest: "Suggest with Kimi",
    suggesting: "Kimi thinking…",
    kimiHold: "Kimi suggests holding",
    proposerDown: "Kimi is unavailable right now",
    freshNote:
      "Previewed against a clean day (0 open, 0 lost). The agent uses your real state when it executes.",
    back: "Cota",
  },
} as const;

// Preview only: a clean day. The real day-state (open notional, loss, trades)
// is the agent's to read at execution, and enforce.ts judges it there.
const FRESH_DAY: DayState = {
  tradesToday: 0,
  lossTodayUsdE6: 0n,
  openNotionalUsdE6: 0n,
};

export default function TradePage() {
  const lang: Lang = useLocale() === "es" ? "es" : "en";
  const t = T[lang];
  const auth = useAuthSlot();

  const [cota, setCota] = useState<CotaRow | null | undefined>(undefined);
  const [side, setSide] = useState<"long" | "short">("long");
  const [notional, setNotional] = useState("3");
  const [lev, setLev] = useState("1");
  const [market, setMarket] = useState<string | null>(null);
  // Captured once (state initializer is allowed to be impure); keeps the
  // verdict useMemo pure. A preview doesn't need second-precision "now".
  const [now] = useState(() => BigInt(Math.floor(Date.now() / 1000)));
  const [kimiBusy, setKimiBusy] = useState(false);
  const [kimiNote, setKimiNote] = useState<string | null>(null);
  const [placePhase, setPlacePhase] = useState<
    "idle" | "placing" | "done" | "error"
  >("idle");
  const [placeMsg, setPlaceMsg] = useState<string | null>(null);
  // The one refusal the hunter can clear themselves, so it is held apart from
  // the message: forwarding is off on their Perpl account and switching it on
  // is a transaction from their own wallet. See lib/cota/forwarding.ts.
  const [forwardingOff, setForwardingOff] = useState(false);
  const [fwdBusy, setFwdBusy] = useState(false);
  // The other refusal a hunter can clear: the venue holds size the fill ledger
  // never saw. Only offered when the server says it is adoptable — a position
  // the venue no longer prices cannot be, and pretending otherwise would send
  // the hunter to a button that can only fail.
  // The open position, read from the venue (not the ledger, which can be a read
  // behind). It is what the Close controls act on and what decides their side.
  const [position, setPosition] = useState<{
    side: "long" | "short";
    signedSize: number;
    entryUsd: number | null;
    leverageX: number;
    notionalUsd: number;
    unrealisedUsd: number | null;
  } | null>(null);
  const [posMark, setPosMark] = useState<number | null>(null);
  const [closeBusy, setCloseBusy] = useState(false);
  const [closeMsg, setCloseMsg] = useState<string | null>(null);
  const [unreconciled, setUnreconciled] = useState(false);
  // Revoking is irreversible, so it takes two taps: the first arms it, the
  // second does it. A hunter must not be able to end their own authorisation
  // with a mis-tap.
  const [revokeArmed, setRevokeArmed] = useState(false);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [reconBusy, setReconBusy] = useState(false);

  useEffect(() => {
    if (auth.status !== "signed-in") return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/cota");
        if (!res.ok) {
          if (live) setCota(null);
          return;
        }
        const body = (await res.json()) as { cotas?: CotaRow[] };
        const active = (body.cotas ?? []).find(
          (c) => c.revokedAt === null && c.markets.length > 0,
        );
        if (live) {
          setCota(active ?? null);
          setMarket(active?.markets[0] ?? null);
        }
      } catch {
        if (live) setCota(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [auth.status]);

  const bound = useMemo(() => (cota ? boundFromRow(cota) : null), [cota]);

  // The leash verdict for the current inputs, computed by the very code the
  // agent enforces with.
  const decision = useMemo(() => {
    if (!bound || !market) return null;
    let order: ProposedOrder;
    try {
      order = {
        venue: bound.venue,
        market,
        notionalUsdE6: usdE6(Number(notional || "0"), "notional"),
        leverageX100: leverageX100(Number(lev || "0"), "leverage"),
      };
    } catch {
      return null; // off-grid / unparseable input
    }
    return mayOpen(bound, FRESH_DAY, order, now);
  }, [bound, market, notional, lev, now]);

  const human = (e6: string) => (Number(e6) / 1e6).toString();

  // Kimi proposes; the SAME leash gate judges it. Fills the form from the
  // suggestion — the verdict re-computes from the filled inputs.
  async function suggest() {
    setKimiBusy(true);
    setKimiNote(null);
    try {
      const res = await fetch("/api/cota/propose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cota ? { digest: cota.digest } : {}),
      });
      const body = (await res.json()) as {
        proposal?: {
          action: string;
          market?: string;
          side?: "long" | "short";
          notionalUsd?: number;
          leverage?: number;
          rationale?: string;
        };
        error?: string;
        detail?: string;
      };
      if (!res.ok || !body.proposal) {
        // `detail` carries the upstream reason — an expired key, a model the
        // account cannot call, a billing suspension. Dropping it once cost a
        // night of debugging against a screen that only said "unavailable".
        setKimiNote(
          [body.error, body.detail].filter(Boolean).join(" — ") ||
            t.proposerDown,
        );
        return;
      }
      const pr = body.proposal;
      if (
        pr.action === "open" &&
        pr.market &&
        pr.notionalUsd != null &&
        pr.leverage != null
      ) {
        setMarket(pr.market);
        if (pr.side) setSide(pr.side);
        setNotional(String(pr.notionalUsd));
        setLev(String(pr.leverage));
        setKimiNote(pr.rationale ?? null);
      } else {
        setKimiNote(`${t.kimiHold}: ${pr.rationale ?? ""}`);
      }
    } catch {
      setKimiNote(t.proposerDown);
    } finally {
      setKimiBusy(false);
    }
  }

  // Switch order forwarding on for this hunter's Perpl account. Nothing about
  // the order is retried here — the hunter places again, and sees the real
  // result of the same order they already approved.
  async function enableForwarding() {
    setFwdBusy(true);
    try {
      const { account } = await signInAccount();
      await setOrderForwarding(account, true);
      setForwardingOff(false);
      setPlaceMsg(t.fwdFixed);
      setPlacePhase("idle");
    } catch (e) {
      setPlaceMsg(explainForwardingError(e, lang));
    } finally {
      setFwdBusy(false);
    }
  }

  // Adopt a position the ledger never recorded, at the venue's entry price.
  // Deliberately a separate tap from placing: it is the hunter taking on size
  // the agent cannot vouch for, and it must not ride along inside a retry.
  async function reconcile() {
    setReconBusy(true);
    try {
      const res = await fetch("/api/cota/reconcile", { method: "POST" });
      const body = (await res.json()) as {
        adopted?: { sizeUnits: number }[];
        error?: string;
      };
      if (!res.ok) {
        setPlaceMsg(`${t.reconcileFailed}: ${body.error ?? ""}`.trim());
        return;
      }
      if ((body.adopted?.length ?? 0) === 0) {
        setPlaceMsg(t.reconcileNothing);
        return;
      }
      setUnreconciled(false);
      setPlaceMsg(t.reconciled);
      setPlacePhase("idle");
    } catch {
      setPlaceMsg(t.reconcileFailed);
    } finally {
      setReconBusy(false);
    }
  }

  // Withdraw the leash. Stops anything new from opening; the open position and
  // the enrolled key are both left alone, because closing a position to tidy up
  // an authorisation would be deciding for the hunter at the market's price.
  async function revoke() {
    if (!cota?.digest) return;
    setRevokeBusy(true);
    try {
      const res = await fetch("/api/cota/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ digest: cota.digest }),
      });
      const body = (await res.json()) as { revoked?: boolean; error?: string };
      if (!res.ok || !body.revoked) {
        setPlaceMsg(`${t.revokeFailed}: ${body.error ?? ""}`.trim());
        return;
      }
      setRevokeArmed(false);
      setPlaceMsg(t.revoked);
      setPlacePhase("idle");
      // The leash the page was holding is no longer active, and the server will
      // not find it either. Drop it rather than keep offering a Place button
      // whose order can only be refused.
      setCota(null);
      setMarket(null);
    } catch {
      setPlaceMsg(t.revokeFailed);
    } finally {
      setRevokeBusy(false);
    }
  }

  // Place the (leash-approved) order. The server route re-runs the gate before
  // it touches the venue; this button is only enabled when the preview allows.
  async function place() {
    if (!market) return;
    setPlacePhase("placing");
    setPlaceMsg(null);
    setForwardingOff(false);
    setUnreconciled(false);
    try {
      const res = await fetch("/api/cota/trade", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          digest: cota?.digest,
          market,
          side,
          targetNotionalUsd: Number(notional || "0"),
          leverageX: Number(lev || "0"),
        }),
      });
      const body = (await res.json()) as {
        allowed?: boolean;
        filled?: boolean;
        accepted?: boolean;
        reason?: string;
        detail?: string;
        error?: string;
        code?: number;
        reconcilable?: boolean;
        venue?: {
          statusName?: string;
          reasonName?: string;
          filledScaled?: number;
          originalScaled?: number;
          /** Size changed hands; the mt 25 with the price is still in flight. */
          expectsFill?: boolean;
        } | null;
      };
      if (!res.ok) {
        setPlaceMsg(body.error ?? t.placeFailed);
        setPlacePhase("error");
      } else if (body.allowed === false) {
        setPlaceMsg(
          (body.reason ? refusalText(body.reason, lang) : null) ??
            body.detail ??
            t.placeRejected,
        );
        if (body.reason === "forwarding_disabled") setForwardingOff(true);
        if (body.reason === "loss_unverifiable" && body.reconcilable)
          setUnreconciled(true);
        setPlacePhase("error");
      } else if (body.filled) {
        setPlaceMsg(t.placed);
        setPlacePhase("done");
      } else if (body.accepted) {
        // "Accepted (not filled yet)" on its own is what every silent failure
        // looked like. When the venue said what became of the order, say that
        // instead — its own status and reason, unparaphrased.
        //
        // And when what it said is that the order TRADED, do not lead with "not
        // filled yet". `expectsFill` means size changed hands and only the price
        // frame is still in flight; the two halves of
        // "Accepted (not filled yet) — Filled: TakerOrderFilled" contradicted
        // each other, and the half that was right was the venue's.
        const v = body.venue;
        const head = v?.expectsFill ? t.placeFilledPending : t.placeAccepted;
        setPlaceMsg(
          v?.statusName
            ? `${head} — ${v.statusName}: ${v.reasonName ?? "?"}`
            : head,
        );
        setPlacePhase("done");
      } else {
        // The leash allowed it and the VENUE refused. `error` carries the real
        // reason — OrderForwardingNotAllowed is the one to expect on a fresh
        // account, and the gateway returns code 0 while the chain rejects, so
        // without this it reads as an ordinary non-fill. Never swallow it.
        setPlaceMsg(
          body.error
            ? `${t.placeFailed}: ${body.error}`
            : body.code != null
              ? `${t.placeFailed} (code ${body.code})`
              : t.placeFailed,
        );
        setPlacePhase("error");
      }
    } catch {
      setPlaceMsg(t.placeFailed);
      setPlacePhase("error");
    }
  }

  const refreshPosition = useCallback(async () => {
    if (!market) return;
    try {
      const res = await fetch(
        `/api/cota/close?market=${encodeURIComponent(market)}`,
      );
      if (!res.ok) return;
      const body = (await res.json()) as {
        position?: typeof position;
        markUsd?: number;
      };
      setPosition(body.position ?? null);
      setPosMark(body.markUsd ?? null);
    } catch {
      // A position we could not read is shown as unknown, never as flat:
      // rendering "no position" on a failed fetch would tell a hunter they are
      // out when they are not.
    }
  }, [market]);

  // Polled, not read once: the mark moves, and an unrealised PnL that is stale
  // is worse than none — it is the number a hunter decides to close on. The
  // `live` flag stops a reply from a market they have switched away from
  // landing on the new one.
  useEffect(() => {
    let live = true;
    const tick = () => {
      if (live) void refreshPosition();
    };
    tick();
    const id = setInterval(tick, 10000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [refreshPosition]);

  // Reduce or close. Deliberately not routed through the leash preview above:
  // the preview gates OPENS, and a reduce is not gated. See mayReduce.
  async function close(fraction: 1 | 0.5) {
    if (!market || !position) return;
    setCloseBusy(true);
    setCloseMsg(null);
    try {
      const held = Math.abs(position.signedSize);
      const res = await fetch("/api/cota/close", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          market,
          // Full close sends no size at all, so the server closes exactly what
          // the venue reports rather than a number this page computed from a
          // read that may already be stale.
          ...(fraction === 1 ? {} : { sizeUnits: held * fraction }),
        }),
      });
      const body = (await res.json()) as {
        allowed?: boolean;
        reason?: string;
        filled?: boolean;
        accepted?: boolean;
        error?: string;
        venue?: { statusName?: string; reasonName?: string } | null;
      };
      if (!res.ok) {
        setCloseMsg(body.error ?? t.closeFailed);
      } else if (body.allowed === false) {
        setCloseMsg(
          (body.reason ? refusalText(body.reason, lang) : null) ??
            t.closeFailed,
        );
      } else if (body.filled) {
        setCloseMsg(t.closeDone);
      } else {
        const v = body.venue;
        setCloseMsg(
          v?.statusName
            ? `${t.closeAccepted} — ${v.statusName}: ${v.reasonName ?? "?"}`
            : t.closeAccepted,
        );
      }
    } catch {
      setCloseMsg(t.closeFailed);
    } finally {
      setCloseBusy(false);
      void refreshPosition();
    }
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
          <Button onClick={() => void auth.signIn()} disabled={!auth.canSignIn}>
            {t.signIn}
          </Button>
        </Panel>
      ) : cota === undefined ? (
        <Panel>
          <p className="text-ink-dim text-sm">…</p>
        </Panel>
      ) : cota === null ? (
        <Panel className="space-y-3">
          <p className="text-ink text-sm">{t.noCota}</p>
          <a
            href="/cota"
            className="bg-phosphor text-void inline-flex min-h-12 items-center justify-center rounded-2xl px-5 text-sm font-semibold"
          >
            {t.goSign}
          </a>
        </Panel>
      ) : (
        <>
          <Panel className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-ink-dim text-xs tracking-wide uppercase">
                {t.leash}
              </p>
              {cota.anchorTxHash ? (
                <a
                  href={`https://monadscan.com/tx/${cota.anchorTxHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-[#4ade80] underline"
                >
                  {t.anchored} ✓
                </a>
              ) : (
                <Pill color="#a1a1aa">{t.notAnchored}</Pill>
              )}
            </div>
            <div className="grid grid-cols-2 gap-1 text-sm">
              <span className="text-ink-dim">{t.market}</span>
              <span className="text-right font-mono">
                {cota.markets.join(", ")}
              </span>
              <span className="text-ink-dim">{t.maxN}</span>
              <span className="text-right font-mono">
                ${human(cota.maxNotionalUsdE6)}
              </span>
              <span className="text-ink-dim">{t.maxL}</span>
              <span className="text-right font-mono">
                {Number(cota.maxLeverageX100) / 100}×
              </span>
              <span className="text-ink-dim">{t.dayLoss}</span>
              <span className="text-right font-mono">
                ${human(cota.maxDailyLossUsdE6)}
              </span>
              <span className="text-ink-dim">{t.trades}</span>
              <span className="text-right font-mono">
                {cota.maxTradesPerDay}
              </span>
            </div>
          </Panel>

          <Panel className="space-y-3">
            <label className="text-ink-dim block text-xs tracking-wide uppercase">
              {t.market}
            </label>
            <div className="flex flex-wrap gap-2">
              {cota.markets.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMarket(m)}
                  className="rounded-lg border px-3 py-1.5 text-sm font-semibold"
                  style={{
                    borderColor: market === m ? "#06b6d4" : "rgba(63,63,70,.4)",
                    color: market === m ? "#06b6d4" : "#a1a1aa",
                  }}
                >
                  {m}
                </button>
              ))}
            </div>

            <label className="text-ink-dim block text-xs tracking-wide uppercase">
              {t.side}
            </label>
            <div className="grid grid-cols-2 gap-2">
              {(["long", "short"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSide(s)}
                  className="min-h-11 rounded-xl border-2 text-sm font-semibold"
                  style={{
                    borderColor: side === s ? "#06b6d4" : "rgba(63,63,70,.4)",
                    color: side === s ? "#06b6d4" : "#a1a1aa",
                  }}
                >
                  {s === "long" ? t.long : t.short}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-ink-dim block text-xs tracking-wide uppercase">
                  {t.notional}
                </label>
                <input
                  inputMode="decimal"
                  value={notional}
                  onChange={(e) =>
                    setNotional(e.target.value.replace(/[^0-9.]/g, ""))
                  }
                  className="border-hull-line text-ink mt-1 w-full rounded-xl border-2 bg-transparent px-3 py-2 font-mono"
                />
              </div>
              <div>
                <label className="text-ink-dim block text-xs tracking-wide uppercase">
                  {t.leverage}
                </label>
                <input
                  inputMode="decimal"
                  value={lev}
                  onChange={(e) =>
                    setLev(e.target.value.replace(/[^0-9.]/g, ""))
                  }
                  className="border-hull-line text-ink mt-1 w-full rounded-xl border-2 bg-transparent px-3 py-2 font-mono"
                />
              </div>
            </div>
          </Panel>

          <Button
            tone="ghost"
            onClick={() => void suggest()}
            disabled={kimiBusy}
          >
            {kimiBusy ? t.suggesting : `✨ ${t.suggest}`}
          </Button>
          {kimiNote && (
            <p className="text-ink-dim text-[12px] italic">“{kimiNote}”</p>
          )}

          <Panel className="space-y-2">
            <p className="text-ink-dim text-xs tracking-wide uppercase">
              {t.verdict}
            </p>
            {decision === null ? (
              <p className="text-ink-faint text-sm">—</p>
            ) : decision.ok ? (
              <Pill color="#4ade80">{t.allowed}</Pill>
            ) : (
              <Note tone="stop">{refusalText(decision.reason, lang)}</Note>
            )}
            <p className="text-ink-faint text-[11px]">{t.freshNote}</p>
          </Panel>

          <Panel className="space-y-2">
            <p className="text-ink-dim text-xs tracking-wide uppercase">
              {t.posTitle}
            </p>
            {position === null ? (
              <p className="text-ink-faint text-sm">{t.posNone}</p>
            ) : (
              <>
                <div className="text-ink flex items-baseline justify-between">
                  <span className="font-semibold">
                    {t.posSide[position.side]} {Math.abs(position.signedSize)}{" "}
                    {market}
                  </span>
                  <span className="font-mono text-sm">
                    {position.leverageX}x
                  </span>
                </div>
                <div className="text-ink-dim flex justify-between text-xs">
                  <span>{t.posEntry}</span>
                  <span className="font-mono">
                    {position.entryUsd?.toFixed(6) ?? "—"}
                  </span>
                </div>
                <div className="text-ink-dim flex justify-between text-xs">
                  <span>{t.posMark}</span>
                  <span className="font-mono">
                    {posMark?.toFixed(6) ?? "—"}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-ink-dim">{t.posPnl}</span>
                  <span
                    className={`font-mono ${
                      (position.unrealisedUsd ?? 0) < 0
                        ? "text-alert"
                        : "text-[#4ade80]"
                    }`}
                  >
                    {position.unrealisedUsd === null
                      ? "—"
                      : `${position.unrealisedUsd >= 0 ? "+" : ""}${position.unrealisedUsd.toFixed(4)}`}
                  </span>
                </div>
                {(position.unrealisedUsd ?? 0) < 0 && (
                  <Note tone="warn">{t.closeAtLoss}</Note>
                )}
                <div className="flex gap-2 pt-1">
                  <Button
                    onClick={() => void close(1)}
                    disabled={closeBusy}
                    className="flex-1"
                  >
                    {closeBusy ? t.closing : t.closeAll}
                  </Button>
                  <Button
                    onClick={() => void close(0.5)}
                    disabled={closeBusy}
                    className="flex-1"
                  >
                    {t.closeHalf}
                  </Button>
                </div>
                {closeMsg && (
                  <p className="text-ink-dim text-center text-[12px]">
                    {closeMsg}
                  </p>
                )}
              </>
            )}
          </Panel>

          <Button
            onClick={() => void place()}
            disabled={
              placePhase === "placing" ||
              decision === null ||
              !decision.ok ||
              !market
            }
          >
            {placePhase === "placing" ? t.placing : t.place}
          </Button>
          {placeMsg && (
            <p
              className={`text-center text-[12px] ${
                placePhase === "done" ? "text-[#4ade80]" : "text-alert"
              }`}
            >
              {placeMsg}
            </p>
          )}
          {unreconciled && (
            <>
              <p className="text-ink-dim text-[12px]">{t.reconcileNote}</p>
              <Button onClick={() => void reconcile()} disabled={reconBusy}>
                {reconBusy ? t.reconciling : t.reconcile}
              </Button>
            </>
          )}
          {forwardingOff && (
            <Button onClick={() => void enableForwarding()} disabled={fwdBusy}>
              {fwdBusy ? t.fwdFixing : t.fwdFix}
            </Button>
          )}
          {/* Withdrawing the leash. Two taps, because it cannot be undone. */}
          {cota && (
            <div className="mt-6 border-t border-white/10 pt-4">
              {revokeArmed ? (
                <>
                  <p className="text-ink-dim mb-2 text-[12px]">
                    {t.revokeNote}
                  </p>
                  <div className="flex gap-2">
                    <Button onClick={() => void revoke()} disabled={revokeBusy}>
                      {revokeBusy ? t.revoking : t.revokeConfirm}
                    </Button>
                    <Button
                      onClick={() => setRevokeArmed(false)}
                      disabled={revokeBusy}
                    >
                      {t.revokeCancel}
                    </Button>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setRevokeArmed(true)}
                  className="text-ink-dim text-[12px] underline underline-offset-2"
                >
                  {t.revoke}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </main>
  );
}
