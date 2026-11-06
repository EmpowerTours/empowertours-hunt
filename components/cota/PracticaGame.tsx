"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { Button, Note, Panel } from "@/components/ui/primitives";
import { SignInPrompt } from "@/components/auth/SignInPrompt";
import { LanguageSwitch } from "@/components/hunt/LanguageSwitch";

// ---------------------------------------------------------------------------
// Cota Práctica, the root of the cota subdomain — quote and take against the bot, settled on Perpl's real MON
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
  typical: number | null;
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
    title: "Cota · Práctica",
    lede: "Cada ronda hay dos líneas alrededor del precio de MON: una ARRIBA y una ABAJO. Apuesta ▲ Sube y ganas si el minuto siguiente cierra por encima de la línea de arriba. Apuesta ▼ Baja y ganas si cierra por debajo de la de abajo. Si cierra entre las dos, gana quien dibujó las líneas. Tú y el bot se turnan: uno dibuja, el otro apuesta.",
    play: "Puntos de juego: sin valor, no se retiran. 1 punto = 0.01% del precio. Precios reales de Perpl.",
    signIn: "Inicia sesión con tu llave de acceso para jugar.",
    signInBtn: "Iniciar sesión",
    real: "Dinero real →",
    feed: "No se pudo leer el precio de Perpl. Reintentando…",
    start: "Nueva partida contra el bot",
    round: "Ronda",
    you: "Tú",
    bot: "Bot",
    passes: "Saltos",
    youTake: "Tú apuestas",
    youQuote: "Tú dibujas",
    botQuoted:
      "El bot dibujó las líneas. ¿El minuto siguiente cierra fuera de ellas?",
    up: "Línea arriba",
    down: "Línea abajo",
    buy: "▲ Sube",
    buySub: (p: string) => `cierra ${p} o más arriba`,
    sell: "▼ Baja",
    sellSub: (p: string) => `cierra ${p} o más abajo`,
    pass: "Saltar",
    passSub: (n: number) => `te quedan ${n}`,
    quoteHelp: (typ: string) =>
      `Dibuja dos líneas. El bot apostará al lado que más le convenga. Si MON cierra entre tus líneas, ganas tú. Líneas cerradas: el bot apuesta más, pero es más fácil que te pase. Líneas abiertas: más seguro, pero el bot puede saltar. MON suele moverse ${typ} por minuto.`,
    closer: "más cerca",
    farther: "más lejos",
    shiftDown: "▼ Bajar ambas",
    shiftUp: "Subir ambas ▲",
    send: "Listo, que apueste el bot",
    spread: (p: string) => `Espacio entre tus líneas: ${p}`,
    waiting: (s: string, at: string) =>
      `Esperando el cierre de las ${at} para decidir tus apuestas. Siguiente ronda en ${s}.`,
    allPlayed: (s: string) =>
      `Ya jugaste las 10 rondas. Faltan los últimos cierres (${s}).`,
    noPrice: "Esperando una operación de MON en Perpl para abrir la ronda.",
    settles: (s: string, at: string) => `se decide a las ${at}, en ${s}`,
    settling: "esperando el cierre",
    final: (y: string, b: string) => `Partida terminada · tú ${y}, bot ${b}`,
    won: "¡Ganaste!",
    lost: "Perdiste.",
    tie: "Empate.",
    rounds: "Rondas",
    none: "Todavía nada.",
    quoted: (w: Who) => (w === "you" ? "Tus líneas" : "Líneas del bot"),
    yourTurn: "Te tocaba dibujar",
    act: (a: Action | null, taker: Who) => {
      const who = taker === "you" ? "apostaste" : "el bot apostó";
      if (a === "buy") return `${who} ▲ Sube`;
      if (a === "sell") return `${who} ▼ Baja`;
      if (a === "pass") return taker === "you" ? "saltaste" : "el bot saltó";
      if (a === "timeout")
        return taker === "bot"
          ? "no dibujaste a tiempo"
          : "no apostaste a tiempo";
      return "…";
    },
    above: (p: string) => `cerró ${p} arriba de la línea`,
    below: (p: string) => `cerró ${p} abajo de la línea`,
    inside: "cerró entre las líneas",
    board: "Tabla semanal →",
    history: "Últimas partidas",
    refused: {
      price_not_between: "El precio se movió. Intenta de nuevo.",
      spread_too_small: "Tus líneas están demasiado juntas.",
      spread_too_wide: "Tus líneas están demasiado separadas.",
      too_late: "Se acabó el tiempo de esa ronda.",
      no_passes: "Ya no te quedan saltos.",
      default: "No se pudo hacer ese movimiento.",
    } as Record<string, string>,
  },
  en: {
    title: "Cota · Practice",
    lede: "Each round has two lines around MON's price: an UP line and a DOWN line. Bet ▲ Higher and you win if the next minute closes above the UP line. Bet ▼ Lower and you win if it closes below the DOWN line. If it closes between them, whoever drew the lines wins. You and the bot take turns: one draws, the other bets.",
    play: "Play points: no value, can't be withdrawn. 1 point = 0.01% of the price. Real Perpl prices.",
    signIn: "Sign in with your passkey to play.",
    signInBtn: "Sign in",
    real: "Real money →",
    feed: "Couldn't read Perpl's price. Retrying…",
    start: "New match against the bot",
    round: "Round",
    you: "You",
    bot: "Bot",
    passes: "Skips",
    youTake: "You bet",
    youQuote: "You draw",
    botQuoted:
      "The bot drew the lines. Will the next minute close outside them?",
    up: "UP line",
    down: "DOWN line",
    buy: "▲ Higher",
    buySub: (p: string) => `closes ${p}+ above now`,
    sell: "▼ Lower",
    sellSub: (p: string) => `closes ${p}+ below now`,
    pass: "Skip",
    passSub: (n: number) => `${n} left`,
    quoteHelp: (typ: string) =>
      `Draw two lines. The bot bets whichever side looks best to it. If MON closes between your lines, you win. Tight lines: the bot bets more, but MON breaks out more easily. Wide lines: safer, but the bot may skip. MON usually moves ${typ} a minute.`,
    closer: "closer",
    farther: "farther",
    shiftDown: "▼ Shift both down",
    shiftUp: "Shift both up ▲",
    send: "Done, let the bot bet",
    spread: (p: string) => `Room between your lines: ${p}`,
    waiting: (s: string, at: string) =>
      `Waiting for the ${at} close to decide your bets. Next round in ${s}.`,
    allPlayed: (s: string) =>
      `All 10 rounds played. Waiting for the last closes (${s}).`,
    noPrice: "Waiting for a MON trade on Perpl to open the round.",
    settles: (s: string, at: string) => `decided at ${at}, in ${s}`,
    settling: "waiting for the close",
    final: (y: string, b: string) => `Match over · you ${y}, bot ${b}`,
    won: "You won!",
    lost: "You lost.",
    tie: "Tie.",
    rounds: "Rounds",
    none: "Nothing yet.",
    quoted: (w: Who) => (w === "you" ? "Your lines" : "Bot's lines"),
    yourTurn: "Your turn to draw",
    act: (a: Action | null, taker: Who) => {
      const who = taker === "you" ? "you bet" : "bot bet";
      if (a === "buy") return `${who} ▲ Higher`;
      if (a === "sell") return `${who} ▼ Lower`;
      if (a === "pass") return taker === "you" ? "you skipped" : "bot skipped";
      if (a === "timeout")
        return taker === "bot"
          ? "you didn't draw in time"
          : "you didn't bet in time";
      return "…";
    },
    above: (p: string) => `closed ${p} past the line`,
    below: (p: string) => `closed ${p} short of the line`,
    inside: "closed between the lines",
    board: "Weekly board →",
    history: "Last matches",
    refused: {
      price_not_between: "The price moved. Try again.",
      spread_too_small: "Your lines are too close together.",
      spread_too_wide: "Your lines are too far apart.",
      too_late: "That round's time ran out.",
      no_passes: "You have no skips left.",
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

export function PracticaGame() {
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
  // The quote a player is still adjusting, as DISTANCES in ticks from the
  // price. The walls follow the live price until it is sent.
  const [draft, setDraft] = useState<{
    n: number;
    below: number;
    above: number;
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

  // A fresh default quote when a quoting round opens: each wall about one
  // typical minute's move away from the price.
  const quoting = cur?.quoter === "you" && v?.price != null && v.limits != null;
  const dflt = quoting
    ? Math.max(Math.ceil(v!.limits!.min / 2), v!.typical ?? 3)
    : 0;
  const q =
    quoting && draft?.n === cur!.n
      ? draft
      : quoting
        ? { n: cur!.n, below: dflt, above: dflt }
        : null;
  const pctOf = (ticks: number, base: number | null | undefined) =>
    base ? `${((Math.abs(ticks) / base) * 100).toFixed(2)}%` : "—";
  const pct = (ticks: number) => pctOf(ticks, v?.price);

  const nudge = (which: "below" | "above" | "lean", d: number) => {
    if (!q || !v?.limits) return;
    let { below, above } = q;
    if (which === "lean") {
      // Leaning up moves both walls up: buy closer, sell farther.
      below -= d;
      above += d;
    } else if (which === "below") below += d;
    else above += d;
    below = Math.max(1, below);
    above = Math.max(1, above);
    const other = which === "below" ? "above" : "below";
    const fix = (sum: number) => {
      if (other === "above") above = Math.max(1, above + sum);
      else below = Math.max(1, below + sum);
    };
    if (below + above < v.limits.min) fix(v.limits.min - (below + above));
    if (below + above > v.limits.max) fix(v.limits.max - (below + above));
    setDraft({ n: q.n, below, above });
  };

  // Walls to draw: the live quote (draft or the bot's), plus pending trades.
  const wallsNow =
    (q && v?.price
      ? { bid: v.price - q.below, ask: v.price + q.above }
      : null) ??
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
        `#${r.n} ${r.action === "buy" ? "▲" : "▼"}`,
        false,
      );
    }
    if (wallsNow) {
      wall(
        wallsNow.ask,
        COLORS.ask,
        `${t.up}${v.price ? ` +${pctOf(wallsNow.ask - v.price, v.price)}` : ""}`,
        true,
      );
      wall(
        wallsNow.bid,
        COLORS.bid,
        `${t.down}${v.price ? ` −${pctOf(v.price - wallsNow.bid, v.price)}` : ""}`,
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
    // Sign in right here: this screen is the root of the cota subdomain, so
    // there is no other page to send the player to. The 2 s poll picks the
    // session up as soon as the passkey ceremony finishes.
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-6">
        <h1 className="text-spawn text-4xl font-black tracking-tight">
          {t.title}
        </h1>
        <p className="text-ink-dim mt-2 text-sm">{t.lede}</p>
        <Panel className="mt-4 space-y-3">
          <p className="text-ink text-sm">{t.signIn}</p>
          <SignInPrompt label={t.signInBtn} />
        </Panel>
      </main>
    );
  }

  const quoteOf = (r: RoundView) =>
    r.bid !== null && r.ask !== null && r.ref !== null
      ? `▼${pctOf(r.ref - r.bid, r.ref)} · ▲${pctOf(r.ask - r.ref, r.ref)}`
      : "—";
  // How the close landed against the line that was bet on.
  const outcome = (r: RoundView) => {
    if (r.close === null || r.bid === null || r.ask === null) return "";
    if (r.action !== "buy" && r.action !== "sell") return "";
    if (r.close > r.bid && r.close < r.ask) return t.inside;
    const d = r.action === "buy" ? r.close - r.ask : r.bid - r.close;
    return d >= 0 ? t.above(pctOf(d, r.ref)) : t.below(pctOf(d, r.ref));
  };
  const hhmm = (ms: number) =>
    new Date(ms).toLocaleTimeString(lang === "es" ? "es-MX" : "en-GB", {
      timeZone: "America/Mexico_City",
      hour: "2-digit",
      minute: "2-digit",
    });
  const pendingNext = pendingTrades
    .map((r) => r.settleAt ?? 0)
    .sort((a, b) => a - b)[0];

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <a href="/cota" className="text-ink-dim font-mono text-xs">
          {t.real}
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
              <span className="text-ink-dim text-sm">{t.botQuoted}</span>
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
                  {t.buySub(pctOf(curRound.ask! - curRound.ref!, curRound.ref))}
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
                  {t.sellSub(
                    pctOf(curRound.ref! - curRound.bid!, curRound.ref),
                  )}
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
              <span className="text-ink-dim text-sm">
                {t.quoteHelp(pct(v.typical ?? 1))}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ["above", t.up, `+${pct(q.above)}`, "text-[#ff9d2e]"],
                  ["below", t.down, `−${pct(q.below)}`, "text-phosphor"],
                ] as const
              ).map(([k, label, dist, cls]) => (
                <div key={k} className="border-hull-line rounded-xl border p-2">
                  <div className="text-ink-dim text-[11px] tracking-wider uppercase">
                    {label}
                  </div>
                  <div className={`font-mono text-2xl font-bold ${cls}`}>
                    {dist}
                  </div>
                  <div className="mt-1 grid grid-cols-2 gap-1">
                    {(
                      [
                        [
                          -Math.max(1, Math.round((v.typical ?? 2) / 2)),
                          t.closer,
                        ],
                        [
                          Math.max(1, Math.round((v.typical ?? 2) / 2)),
                          t.farther,
                        ],
                      ] as const
                    ).map(([d, word]) => (
                      <button
                        key={word}
                        type="button"
                        onClick={() => nudge(k, d)}
                        className="border-hull-line bg-hull-2 text-ink min-h-11 rounded-lg border text-sm"
                      >
                        {word}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                tone="ghost"
                onClick={() =>
                  nudge("lean", -Math.max(1, Math.round((v.typical ?? 2) / 2)))
                }
              >
                {t.shiftDown}
              </Button>
              <Button
                tone="ghost"
                onClick={() =>
                  nudge("lean", Math.max(1, Math.round((v.typical ?? 2) / 2)))
                }
              >
                {t.shiftUp}
              </Button>
            </div>
            <Button
              disabled={busy}
              onClick={() =>
                void act({ action: "quote", below: q.below, above: q.above })
              }
            >
              {t.send}
            </Button>
            <p className="text-ink-faint font-mono text-[11px]">
              {t.spread(pct(q.below + q.above))}
            </p>
          </>
        ) : (
          <Note tone="info">
            {!v?.price
              ? t.noPrice
              : m.rounds.length >= v.rounds
                ? t.allPlayed(clock((pendingNext ?? serverNow) - serverNow))
                : t.waiting(
                    clock((pendingNext ?? serverNow) - serverNow),
                    hhmm(pendingNext ?? serverNow),
                  )}
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
                    ? outcome(r)
                    : r.settleAt
                      ? r.settleAt + 5_000 > serverNow
                        ? t.settles(
                            clock(r.settleAt - serverNow),
                            hhmm(r.settleAt),
                          )
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
                        {r.bid === null
                          ? t.yourTurn
                          : `${t.quoted(r.quoter)} ${quoteOf(r)}`}
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
        <a href="/tabla" className="text-phosphor font-mono text-sm">
          {t.board}
        </a>
      </div>
    </main>
  );
}
