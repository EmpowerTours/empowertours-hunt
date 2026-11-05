"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { Button, LinkButton, Note, Panel } from "@/components/ui/primitives";
import { LanguageSwitch } from "@/components/hunt/LanguageSwitch";

// ---------------------------------------------------------------------------
// Haz Mercado — quote and take against the bot, settled on Perpl's real MON
// minute candles.
//
// Everything on this screen comes from /api/mercado. The page holds only the
// quote a player is still adjusting; prices, the bot's moves, the clock and
// the results arrive from the server.
// ---------------------------------------------------------------------------

type Lang = "es" | "en";
type Who = "you" | "bot";
type Action = "buy" | "sell" | "pass" | "timeout";

interface RoundView {
  n: number;
  quoter: Who;
  ref: number | null;
  bid: number | null;
  ask: number | null;
  action: Action | null;
  lockedAt: number | null;
  settleAt: number | null;
  close: number | null;
  you: number | null;
}
interface View {
  serverNow: number;
  price: number | null;
  trail: Array<{ t: number; p: number }>;
  limits: { min: number; max: number } | null;
  rounds: number;
  match: {
    you: number;
    passes: { you: number; bot: number };
    finished: boolean;
    current: { n: number; quoter: Who; deadline: number | null } | null;
    rounds: RoundView[];
  } | null;
  history: Array<{ id: string; you: number; at: number }>;
}

const T = {
  es: {
    title: "Haz Mercado",
    lede: "Uno pone precio, el otro decide. Quien cotiza pone dos paredes alrededor del precio real de MON: “compro aquí, vendo aquí”. Quien toma compra en la de arriba, vende en la de abajo o pasa. El cierre del minuto siguiente decide quién gana. Se turnan cada ronda.",
    play: "Puntos de juego: sin valor, no se retiran. 1 punto = 0.01% del precio. Precios reales de Perpl.",
    signIn: "Inicia sesión en Hunt para jugar.",
    signInBtn: "Iniciar sesión",
    feed: "No se pudo leer el precio de Perpl. Reintentando…",
    start: "Nueva partida contra el bot",
    round: "Ronda",
    you: "Tú",
    bot: "Bot",
    passes: "Pases",
    youTake: "Tú tomas",
    youQuote: "Tú cotizas",
    botQuoted: (bid: string, ask: string, lean: string) =>
      `El bot compra a ${bid} y vende a ${ask}. ${lean}`,
    leanUp: "Se inclina al alza.",
    leanDown: "Se inclina a la baja.",
    leanNone: "No se inclina.",
    buy: "Comprarle",
    buySub: (p: string) => `a ${p} · ganas si cierra más arriba`,
    sell: "Venderle",
    sellSub: (p: string) => `a ${p} · ganas si cierra más abajo`,
    pass: "Paso",
    passSub: (n: number) => `te quedan ${n}`,
    quoteHelp:
      "Abierto es seguro pero el bot puede pasar; cerrado invita a operar. Mover ambas paredes muestra hacia dónde crees que va.",
    youBuy: "Tú compras a",
    youSell: "Tú vendes a",
    below: (n: number) => `${n} abajo`,
    above: (n: number) => `${n} arriba`,
    leanDownBtn: "◀ Inclinar abajo",
    leanUpBtn: "Inclinar arriba ▶",
    send: "Mostrarle mi precio al bot",
    spread: (p: string, min: number, max: number) =>
      `Diferencial ${p} · mín ${min}, máx ${max} (en ticks de $0.000001)`,
    waiting: (s: string) =>
      `Esperando a que cierre un minuto pendiente (${s}) para abrir la siguiente ronda.`,
    noPrice: "Esperando una operación de MON en Perpl para abrir la ronda.",
    settles: (s: string) => `se decide en ${s}`,
    settling: "esperando el cierre",
    final: (y: string, b: string) => `Partida terminada · tú ${y}, bot ${b}`,
    won: "¡Ganaste!",
    lost: "Perdiste.",
    tie: "Empate.",
    rounds: "Rondas",
    none: "Todavía nada.",
    quoted: (w: Who) => (w === "you" ? "Tú cotizaste" : "Cotizó el bot"),
    act: (a: Action | null, taker: Who) => {
      const who = taker === "you" ? "tú" : "bot";
      if (a === "buy") return `${who} compró`;
      if (a === "sell") return `${who} vendió`;
      if (a === "pass") return `${who} pasó`;
      if (a === "timeout") return "se acabó el tiempo";
      return "…";
    },
    closed: (c: string) => `cerró ${c}`,
    board: "Tabla semanal →",
    history: "Últimas partidas",
    refused: {
      price_not_between:
        "El precio tiene que quedar entre tus paredes. Se movió: ajusta y reenvía.",
      spread_too_small: "Tus paredes están demasiado juntas.",
      spread_too_wide: "Tus paredes están demasiado separadas.",
      too_late: "Se acabó el tiempo de esa ronda.",
      no_passes: "Ya no te quedan pases.",
      default: "No se pudo hacer ese movimiento.",
    } as Record<string, string>,
  },
  en: {
    title: "Haz Mercado",
    lede: "One side names a price, the other decides. The quoter sets two walls around MON's real price: “I buy here, I sell here”. The taker buys at the top wall, sells at the bottom one, or passes. The next minute's close decides who wins. Roles swap every round.",
    play: "Play points: no value, can't be withdrawn. 1 point = 0.01% of the price. Real Perpl prices.",
    signIn: "Sign in to Hunt to play.",
    signInBtn: "Sign in",
    feed: "Couldn't read Perpl's price. Retrying…",
    start: "New match against the bot",
    round: "Round",
    you: "You",
    bot: "Bot",
    passes: "Passes",
    youTake: "You take",
    youQuote: "You quote",
    botQuoted: (bid: string, ask: string, lean: string) =>
      `The bot buys at ${bid} and sells at ${ask}. ${lean}`,
    leanUp: "It leans up.",
    leanDown: "It leans down.",
    leanNone: "It doesn't lean.",
    buy: "Buy from it",
    buySub: (p: string) => `at ${p} · win if it closes higher`,
    sell: "Sell to it",
    sellSub: (p: string) => `at ${p} · win if it closes lower`,
    pass: "Pass",
    passSub: (n: number) => `${n} left`,
    quoteHelp:
      "Wide is safe but the bot may pass; tight invites a trade. Shifting both walls shows which way you think it goes.",
    youBuy: "You buy at",
    youSell: "You sell at",
    below: (n: number) => `${n} below`,
    above: (n: number) => `${n} above`,
    leanDownBtn: "◀ Lean down",
    leanUpBtn: "Lean up ▶",
    send: "Show the bot my quote",
    spread: (p: string, min: number, max: number) =>
      `Spread ${p} · min ${min}, max ${max} (in $0.000001 ticks)`,
    waiting: (s: string) =>
      `Waiting for a pending minute to close (${s}) before the next round opens.`,
    noPrice: "Waiting for a MON trade on Perpl to open the round.",
    settles: (s: string) => `settles in ${s}`,
    settling: "waiting for the close",
    final: (y: string, b: string) => `Match over · you ${y}, bot ${b}`,
    won: "You won!",
    lost: "You lost.",
    tie: "Tie.",
    rounds: "Rounds",
    none: "Nothing yet.",
    quoted: (w: Who) => (w === "you" ? "You quoted" : "Bot quoted"),
    act: (a: Action | null, taker: Who) => {
      const who = taker === "you" ? "you" : "bot";
      if (a === "buy") return `${who} bought`;
      if (a === "sell") return `${who} sold`;
      if (a === "pass") return `${who} passed`;
      if (a === "timeout") return "time ran out";
      return "…";
    },
    closed: (c: string) => `closed ${c}`,
    board: "Weekly board →",
    history: "Last matches",
    refused: {
      price_not_between:
        "The price has to sit between your walls. It moved: adjust and send again.",
      spread_too_small: "Your walls are too close together.",
      spread_too_wide: "Your walls are too far apart.",
      too_late: "That round's time ran out.",
      no_passes: "You have no passes left.",
      default: "That move didn't go through.",
    } as Record<string, string>,
  },
} as const;

const usd = (p: number) => `$${(p / 1e6).toFixed(6)}`;
/** Points are tenths of a basis point. */
const pts = (x: number, sign = true) =>
  `${sign ? (x > 0 ? "+" : x < 0 ? "−" : "±") : x < 0 ? "−" : ""}${Math.abs(x / 10).toFixed(1)}`;
const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const COLORS = {
  void: "#03080a",
  line: "#17343d",
  ink: "#d9f5ec",
  dim: "#78a094",
  price: "#ffd12e",
  bid: "#46ffbe",
  ask: "#ff9d2e",
};

export default function MercadoPage() {
  const locale = useLocale();
  const lang: Lang = locale === "en" ? "en" : "es";
  const t = T[lang];

  const [view, setView] = useState<View | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "signin" | "feed">(
    "loading",
  );
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [draft, setDraft] = useState<{
    n: number;
    bid: number;
    ask: number;
  } | null>(null);
  const [skew, setSkew] = useState(0);
  const canvas = useRef<HTMLCanvasElement | null>(null);

  const ingest = useCallback((v: View) => {
    setSkew(v.serverNow - Date.now());
    setView(v);
    setStatus("ok");
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/mercado", { cache: "no-store" });
      if (r.status === 401) return setStatus("signin");
      if (r.status === 503) return setStatus("feed");
      if (!r.ok) return;
      ingest((await r.json()) as View);
    } catch {
      /* keep the last screen */
    }
  }, [ingest]);

  useEffect(() => {
    void Promise.resolve().then(load);
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 2_000);
    const tickId = setInterval(() => setNow(Date.now()), 250);
    return () => {
      clearInterval(poll);
      clearInterval(tickId);
    };
  }, [load]);

  const act = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setMsg(null);
      try {
        const r = await fetch("/api/mercado", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok) ingest(j as View);
        else {
          setMsg(
            t.refused[(j as { reason?: string }).reason ?? ""] ??
              t.refused.default,
          );
          void load();
        }
      } finally {
        setBusy(false);
      }
    },
    [ingest, load, t],
  );

  const v = view;
  const m = v?.match ?? null;
  const cur = m?.current ?? null;
  const curRound = cur ? (m!.rounds.find((r) => r.n === cur.n) ?? null) : null;
  const serverNow = now + skew;
  const left = cur?.deadline ? cur.deadline - serverNow : 0;

  // A fresh default quote when a quoting round opens: a few ticks either side.
  const quoting = cur?.quoter === "you" && v?.price != null && v.limits != null;
  const q =
    quoting && draft?.n === cur!.n
      ? draft
      : quoting
        ? {
            n: cur!.n,
            bid: v!.price! - Math.max(3, Math.ceil(v!.limits!.min / 2)),
            ask: v!.price! + Math.max(3, Math.ceil(v!.limits!.min / 2)),
          }
        : null;

  const nudge = (which: "bid" | "ask" | "both", d: number) => {
    if (!q || !v?.price || !v.limits) return;
    let { bid, ask } = q;
    if (which === "both") {
      bid += d;
      ask += d;
    } else if (which === "bid") bid += d;
    else ask += d;
    bid = Math.min(bid, v.price - 1);
    ask = Math.max(ask, v.price + 1);
    if (ask - bid < v.limits.min) {
      if (which === "bid") bid = ask - v.limits.min;
      else ask = bid + v.limits.min;
    }
    if (ask - bid > v.limits.max) {
      if (which === "bid") bid = ask - v.limits.max;
      else ask = bid + v.limits.max;
    }
    setDraft({ n: q.n, bid, ask });
  };

  // Walls to draw: the live quote (draft or the bot's), plus pending trades.
  const wallsNow =
    q ??
    (curRound && curRound.bid !== null && curRound.ask !== null
      ? { bid: curRound.bid, ask: curRound.ask }
      : null);
  const pendingTrades = (m?.rounds ?? []).filter(
    (r) => (r.action === "buy" || r.action === "sell") && r.you === null,
  );

  // ---- chart
  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !v) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = cv.clientWidth;
    const H = cv.clientHeight;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.void;
    ctx.fillRect(0, 0, W, H);
    const trail = v.trail.slice(-30);
    const vals = trail.map((x) => x.p);
    if (v.price) vals.push(v.price);
    if (wallsNow) vals.push(wallsNow.bid, wallsNow.ask);
    for (const r of pendingTrades)
      vals.push(r.action === "buy" ? r.ask! : r.bid!);
    if (!vals.length) return;
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    const pad = Math.max(3, (hi - lo) * 0.15);
    lo -= pad;
    hi += pad;
    const L = 8;
    const R = W - 78;
    const top = 14;
    const bot = H - 16;
    const y = (p: number) => bot - ((p - lo) / (hi - lo)) * (bot - top);
    const tEnd = serverNow + 2 * 60_000; // leave room for the settling minutes
    const tStart = tEnd - 32 * 60_000;
    const x = (ms: number) => L + ((ms - tStart) / (tEnd - tStart)) * (R - L);

    ctx.font = "11px ui-monospace, monospace";
    ctx.strokeStyle = COLORS.line;
    ctx.fillStyle = COLORS.dim;
    ctx.lineWidth = 1;
    const step = Math.max(1, Math.round((hi - lo) / 5));
    for (let p = Math.ceil(lo / step) * step; p < hi; p += step) {
      ctx.beginPath();
      ctx.moveTo(L, y(p));
      ctx.lineTo(R, y(p));
      ctx.stroke();
      ctx.fillText(usd(p), R + 6, y(p) + 4);
    }

    // the minutes that will settle pending trades
    ctx.fillStyle = "rgba(255,209,46,.07)";
    for (const r of pendingTrades)
      if (r.settleAt)
        ctx.fillRect(
          x(r.settleAt - 60_000),
          top,
          x(r.settleAt) - x(r.settleAt - 60_000),
          bot - top,
        );

    const wall = (p: number, color: string, label: string, dash: boolean) => {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash(dash ? [6, 5] : []);
      ctx.beginPath();
      ctx.moveTo(L, y(p));
      ctx.lineTo(R, y(p));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = "600 11px ui-monospace, monospace";
      ctx.fillText(label, L + 4, y(p) - 5);
    };
    for (const r of pendingTrades) {
      const p = r.action === "buy" ? r.ask! : r.bid!;
      wall(
        p,
        "rgba(217,245,236,.45)",
        `#${r.n} ${r.action === "buy" ? "▲" : "▼"} ${usd(p)}`,
        false,
      );
    }
    if (wallsNow) {
      wall(
        wallsNow.ask,
        COLORS.ask,
        `${lang === "es" ? "vende" : "sell"} ${usd(wallsNow.ask)}`,
        true,
      );
      wall(
        wallsNow.bid,
        COLORS.bid,
        `${lang === "es" ? "compra" : "buy"} ${usd(wallsNow.bid)}`,
        true,
      );
    }

    if (trail.length) {
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      trail.forEach((pt, i) => {
        const px = x(pt.t + 60_000); // a close belongs to the end of its minute
        if (i) ctx.lineTo(px, y(pt.p));
        else ctx.moveTo(px, y(pt.p));
      });
      if (v.price) ctx.lineTo(x(serverNow), y(v.price));
      ctx.stroke();
    }
    if (v.price) {
      ctx.fillStyle = COLORS.price;
      ctx.beginPath();
      ctx.arc(x(serverNow), y(v.price), 5, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  if (status === "signin") {
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-6">
        <Note tone="info">{t.signIn}</Note>
        <div className="mt-3">
          <LinkButton href="/" tone="primary">
            {t.signInBtn}
          </LinkButton>
        </div>
      </main>
    );
  }

  const quoteOf = (r: RoundView) =>
    r.bid !== null && r.ask !== null ? `${usd(r.bid)} / ${usd(r.ask)}` : "—";
  const lean = (r: RoundView) => {
    if (r.bid === null || r.ask === null || r.ref === null) return t.leanNone;
    const mid = (r.bid + r.ask) / 2 - r.ref;
    return Math.abs(mid) < 1 ? t.leanNone : mid > 0 ? t.leanUp : t.leanDown;
  };
  const pendingNext = pendingTrades
    .map((r) => r.settleAt ?? 0)
    .sort((a, b) => a - b)[0];

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <a href="/cota" className="text-ink-dim font-mono text-xs">
          ← Cota
        </a>
        <LanguageSwitch />
      </div>
      <h1 className="text-spawn text-4xl font-black tracking-tight">
        {t.title}
      </h1>
      <p className="text-ink-dim mt-2 text-sm">{t.lede}</p>
      <p className="text-ink-faint mt-1 text-xs">{t.play}</p>

      {status === "feed" ? (
        <div className="mt-3">
          <Note tone="warn">{t.feed}</Note>
        </div>
      ) : null}

      {m ? (
        <div className="mt-4 grid grid-cols-4 gap-2 font-mono">
          {[
            [
              t.round,
              `${Math.min(m.rounds.length, v!.rounds)}/${v!.rounds}`,
              "text-spawn",
            ],
            [t.you, pts(m.you), m.you >= 0 ? "text-phosphor" : "text-alert"],
            [t.bot, pts(-m.you), -m.you >= 0 ? "text-phosphor" : "text-alert"],
            [t.passes, `${m.passes.you}`, "text-ink"],
          ].map(([label, value, cls]) => (
            <div
              key={label}
              className="border-hull-line bg-hull rounded-xl border px-3 py-2"
            >
              <div className="text-ink-dim text-[10px] tracking-[0.18em] uppercase">
                {label}
              </div>
              <div className={`text-2xl font-black ${cls}`}>{value}</div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="border-hull-line mt-3 overflow-hidden rounded-2xl border">
        <div className="flex items-baseline justify-between px-3 pt-2 font-mono">
          <span className="text-ink text-xl font-bold">
            {v?.price ? usd(v.price) : "—"}
          </span>
          <span className="text-ink-faint text-[11px]">MON · Perpl · 1m</span>
        </div>
        <canvas
          ref={canvas}
          className="block h-[260px] w-full"
          aria-label="MON"
        />
        {cur?.deadline ? (
          <div className="bg-hull-2 h-1">
            <div
              className="bg-spawn h-full"
              style={{
                width: `${Math.max(0, Math.min(100, (left / (cur.quoter === "you" ? 20_000 : 15_000)) * 100))}%`,
              }}
            />
          </div>
        ) : null}
      </div>

      {msg ? (
        <div className="mt-2">
          <Note tone="warn">{msg}</Note>
        </div>
      ) : null}

      <div className="mt-3 grid gap-3">
        {!m || m.finished ? (
          <>
            {m?.finished ? (
              <Panel>
                <div
                  className={`text-2xl font-black ${m.you > 0 ? "text-phosphor" : m.you < 0 ? "text-alert" : "text-ink"}`}
                >
                  {m.you > 0 ? t.won : m.you < 0 ? t.lost : t.tie}
                </div>
                <div className="text-ink-dim font-mono text-sm">
                  {t.final(pts(m.you), pts(-m.you))}
                </div>
              </Panel>
            ) : null}
            <Button
              disabled={busy || !v?.price}
              onClick={() => void act({ action: "start" })}
            >
              {t.start}
            </Button>
          </>
        ) : cur?.quoter === "bot" && curRound ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="bg-spawn text-void rounded-full px-3 py-1 text-xs font-bold tracking-wider uppercase">
                {t.youTake} · {clock(left)}
              </span>
              <span className="text-ink-dim text-sm">
                {t.botQuoted(
                  usd(curRound.bid!),
                  usd(curRound.ask!),
                  lean(curRound),
                )}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void act({ action: "take", side: "buy" })}
                className="min-h-16 rounded-2xl border-2 border-[#46ffbe] bg-[#46ffbe] px-2 py-2 font-bold text-[#03080a] disabled:opacity-50"
              >
                {t.buy}
                <span className="block font-mono text-[11px] font-medium">
                  {t.buySub(usd(curRound.ask!))}
                </span>
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void act({ action: "take", side: "sell" })}
                className="min-h-16 rounded-2xl border-2 border-[#ff9d2e] bg-[#ff9d2e] px-2 py-2 font-bold text-[#03080a] disabled:opacity-50"
              >
                {t.sell}
                <span className="block font-mono text-[11px] font-medium">
                  {t.sellSub(usd(curRound.bid!))}
                </span>
              </button>
              <button
                type="button"
                disabled={busy || m.passes.you === 0}
                onClick={() => void act({ action: "take", side: "pass" })}
                className="border-hull-line text-ink min-h-16 rounded-2xl border-2 px-2 py-2 font-bold disabled:opacity-40"
              >
                {t.pass}
                <span className="text-ink-dim block font-mono text-[11px] font-medium">
                  {t.passSub(m.passes.you)}
                </span>
              </button>
            </div>
          </>
        ) : q && v?.price && v.limits ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="bg-spawn text-void rounded-full px-3 py-1 text-xs font-bold tracking-wider uppercase">
                {t.youQuote} · {clock(left)}
              </span>
              <span className="text-ink-dim text-sm">{t.quoteHelp}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  [
                    "bid",
                    t.youBuy,
                    q.bid,
                    t.below(v.price - q.bid),
                    "text-phosphor",
                  ],
                  [
                    "ask",
                    t.youSell,
                    q.ask,
                    t.above(q.ask - v.price),
                    "text-[#ff9d2e]",
                  ],
                ] as const
              ).map(([k, label, p, dist, cls]) => (
                <div key={k} className="border-hull-line rounded-xl border p-2">
                  <div className="text-ink-dim flex justify-between text-[11px] tracking-wider uppercase">
                    <span>{label}</span>
                    <span>{dist}</span>
                  </div>
                  <div className={`font-mono text-lg font-bold ${cls}`}>
                    {usd(p)}
                  </div>
                  <div className="mt-1 grid grid-cols-4 gap-1">
                    {[-5, -1, 1, 5].map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => nudge(k, d)}
                        className="border-hull-line bg-hull-2 text-ink min-h-11 rounded-lg border font-mono text-sm"
                      >
                        {d > 0 ? `+${d}` : `−${-d}`}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button tone="ghost" onClick={() => nudge("both", -2)}>
                {t.leanDownBtn}
              </Button>
              <Button tone="ghost" onClick={() => nudge("both", 2)}>
                {t.leanUpBtn}
              </Button>
            </div>
            <Button
              disabled={busy}
              onClick={() =>
                void act({ action: "quote", bid: q.bid, ask: q.ask })
              }
            >
              {t.send}
            </Button>
            <p className="text-ink-faint font-mono text-[11px]">
              {t.spread(String(q.ask - q.bid), v.limits.min, v.limits.max)}
            </p>
          </>
        ) : (
          <Note tone="info">
            {!v?.price
              ? t.noPrice
              : t.waiting(clock((pendingNext ?? serverNow) - serverNow))}
          </Note>
        )}
      </div>

      <Panel className="mt-4">
        <h2 className="text-ink mb-2 text-lg font-semibold">{t.rounds}</h2>
        {!m || m.rounds.length === 0 ? (
          <p className="text-ink-faint text-sm">{t.none}</p>
        ) : (
          <ol className="grid gap-2 text-sm">
            {m.rounds
              .slice()
              .reverse()
              .map((r) => {
                const taker: Who = r.quoter === "you" ? "bot" : "you";
                const state =
                  r.you !== null
                    ? r.close !== null
                      ? t.closed(usd(r.close))
                      : ""
                    : r.settleAt
                      ? r.settleAt + 5_000 > serverNow
                        ? t.settles(clock(r.settleAt - serverNow))
                        : t.settling
                      : "";
                return (
                  <li
                    key={r.n}
                    className="border-hull-line grid grid-cols-[2rem_1fr_auto] items-baseline gap-2 border-b pb-2"
                  >
                    <span className="text-ink-dim font-mono">#{r.n}</span>
                    <span>
                      <span className="text-ink">
                        {t.quoted(r.quoter)} {quoteOf(r)}
                      </span>
                      <span className="text-ink-dim block font-mono text-[11px]">
                        {r.action ? t.act(r.action, taker) : "…"}{" "}
                        {state ? `· ${state}` : ""}
                      </span>
                    </span>
                    <span
                      className={`font-mono font-bold ${r.you === null ? "text-ink-faint" : r.you > 0 ? "text-phosphor" : r.you < 0 ? "text-alert" : "text-ink-dim"}`}
                    >
                      {r.you === null ? "…" : pts(r.you)}
                    </span>
                  </li>
                );
              })}
          </ol>
        )}
      </Panel>

      {v && v.history.length ? (
        <Panel className="mt-4">
          <h2 className="text-ink mb-2 text-lg font-semibold">{t.history}</h2>
          <ol className="grid gap-1 font-mono text-sm">
            {v.history.map((h) => (
              <li key={h.id} className="flex justify-between">
                <span className="text-ink-dim">
                  {new Date(h.at).toLocaleString(
                    lang === "es" ? "es-MX" : "en-GB",
                    {
                      timeZone: "America/Mexico_City",
                      dateStyle: "short",
                      timeStyle: "short",
                    },
                  )}
                </span>
                <span
                  className={
                    h.you > 0
                      ? "text-phosphor"
                      : h.you < 0
                        ? "text-alert"
                        : "text-ink-dim"
                  }
                >
                  {pts(h.you)}
                </span>
              </li>
            ))}
          </ol>
        </Panel>
      ) : null}

      <div className="mt-4">
        <a
          href="/cota/mercado/tabla"
          className="text-phosphor font-mono text-sm"
        >
          {t.board}
        </a>
      </div>
    </main>
  );
}
