"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { SignInPrompt } from "@/components/auth/SignInPrompt";
import { LanguageSwitch } from "@/components/hunt/LanguageSwitch";
import {
  CHIPS,
  NB,
  bandOf,
  baseline,
  defaultSpread,
  previewPoints,
  sgn,
  shares,
  sum,
} from "./chipboardMath";
import {
  apply,
  initialState,
  lastPrice,
  openRound,
  parseFrame,
  type GameState,
  type HistoryEntry,
  type RoundView,
} from "./chipboardState";
import css from "./ChipBoard.module.css";

// ---------------------------------------------------------------------------
// Cota Chip Board — the approved mockup (cota-chips.html) on the real game
// server (services/chipboard).
//
// The server is the judge: rounds, bands, the lock, the close, the baseline,
// every score and the standings arrive over the WebSocket. The client sends
// intentions only ({t:"set"} and {t:"add"}), shows chips optimistically until
// the server answers, and computes nothing but the labelled preview column.
//
// Connection: a token from /api/chipboard/token, then {"t":"auth","token"} as
// the first message. Reconnects with jittered exponential backoff, except on
// 4001 (this player opened the board somewhere else: offer to play here) and
// repeated 4003 (the server keeps refusing our token: stop and say so).
// ---------------------------------------------------------------------------

type Lang = "es" | "en";
type Conn =
  | "connecting"
  | "live"
  | "reconnecting"
  | "signin"
  | "inactive"
  | "replaced"
  | "unavailable"
  | "authfail";

const T = {
  es: {
    title: "Cota Chip Board",
    sub: "Torneo diario · índice BTC",
    today: "Hoy",
    rounds: "Rondas",
    rank: "Lugar",
    tapAdds: "Cada toque",
    remove: "Quitar 10",
    dflt: "Reparto base",
    clear: "Vaciar",
    inHand: "En mano",
    tourney: "Torneo de hoy",
    yourRounds: "Tus rondas",
    emptyRounds: "Aquí aparecen tus resultados cuando cierra cada ronda.",
    emptyBoard: "Nadie ha cerrado una ronda hoy.",
    you: "tú",
    anon: "jugador",
    lbNote: (q: number, n: number) =>
      `* necesita ${q} rondas para competir por premios (tú: ${n}/${q}). Se reinicia a medianoche, hora de Ciudad de México.`,
    rulesTitle: "Por qué es difícil hacer trampa",
    rules: (q: number) => [
      <>
        Las fichas <b>se cierran un minuto completo</b> antes del precio que las
        califica, así que un feed más rápido no sirve de nada.
      </>,
      <>
        Se califica con un <b>índice que mezcla varias casas de cambio</b> al
        cierre, no con una sola operación de Perpl.
      </>,
      <>
        <b>No hay momios que vencer.</b> Copiar el reparto base da exactamente
        0; solo ganas si lees el mercado mejor.
      </>,
      <>
        <b>¿No hay precio del índice al cierre? La ronda se anula,</b> no se
        paga.
      </>,
      <>
        Se clasifica con <b>{q}+ rondas</b>, solo cuentas verificadas con ID,
        así que ni la suerte de una vez ni las cuentas extra ganan.
      </>,
    ],
    kicker: "Juego nuevo",
    h1: (
      <>
        Apila tus fichas donde <em>cae BTC</em>
      </>
    ),
    steps: [
      "Cada ronda tiene una columna de bandas de precio parada en su hora de cierre, un minuto después de que la ronda se cierra a fichas. Tienes 100 fichas por ronda.",
      "Toca una banda para apilar fichas. Amontónalas si estás seguro, repártelas si no. Cada banda muestra los puntos que ganarías si BTC cierra ahí.",
      "La ronda se cierra a fichas a los 20 segundos y su columna se forma en la fila. Un minuto después el precio llega a ella y se califica. Una ronda nueva abre en cuanto otra se cierra.",
    ],
    pitch:
      "Más fichas en la banda donde cae BTC dan más puntos, pero poner todo en una sola banda cuesta mucho si te equivocas. Tu mejor jugada es repartir las fichas como de verdad ves las probabilidades. Es un torneo diario: cada quien juega cuando quiere y gana el mejor total.",
    go: "Dame mis primeras 100 fichas",
    fine: (rule: string | null) =>
      `Puntos de juego: sin valor, no se retiran. Cada ronda: 20 s para poner fichas y cierre 60 s después. Precio de cierre: ${rule ?? "índice"}. El servidor califica; los puntos en la columna son una vista previa.`,
    round: "RONDA",
    locksIn: (s: string) => `se cierra en ${s}s`,
    caption: (hold: number) =>
      `cierra ${hold}s después de cerrarse · pts si cae aquí →`,
    caption2: (band: number, sigma: number) =>
      `banda $${band} · σ ${sigma.toFixed(1)} · puntos en vista previa`,
    now: "AHORA",
    waiting: "Esperando la siguiente ronda…",
    closedAt: (n: string, p: string) => `Ronda ${n} cerró en ${p}`,
    voidToast: "Ronda anulada",
    pts: "pts",
    rowClosed: (n: string, p: string) => `R${n} · cerró ${p}`,
    rowVoid: (n: string) => `R${n} · anulada`,
    onWinning: (mine: number, base: number) =>
      `${mine} de tus fichas estaban en la banda ganadora (reparto base: ${base})`,
    voidWhy: (r: string, phase?: string) =>
      `${VOID_ES[r] ?? r}${phase === "lock" ? " (al cerrar fichas)" : phase === "close" ? " (al cierre)" : ""}. No cuenta.`,
    conn: {
      connecting: "conectando",
      live: "en vivo",
      reconnecting: "reconectando",
      signin: "sin sesión",
      inactive: "cuenta inactiva",
      replaced: "en otra pestaña",
      unavailable: "no disponible",
      authfail: "sin acceso",
    } satisfies Record<Conn, string>,
    signInTitle: "Inicia sesión para jugar",
    signIn: "Inicia sesión con tu llave de acceso para recibir tus fichas.",
    signInBtn: "Iniciar sesión",
    replacedTitle: "Abriste el tablero en otra pestaña",
    replaced:
      "Solo una conexión por jugador. Tus fichas siguen en el servidor; puedes seguir jugando aquí.",
    playHere: "Jugar aquí",
    unavailable:
      "El servidor del juego no responde. Reintentando por nuestra cuenta…",
    authfail:
      "El servidor del juego rechazó la sesión. Recarga la página; si sigue, avísanos.",
    inactive: "Tu cuenta no está activa.",
    reload: "Recargar",
    refused: {
      round_locked: "Esa ronda ya cerró sus fichas.",
      round_unknown: "Esa ronda ya no recibe fichas.",
      over_100: "Solo tienes 100 fichas por ronda.",
      bad_band: "Movimiento no válido.",
      bad_message: "Movimiento no válido.",
      rate_limited: "Más despacio.",
      offline: "Sin conexión. Reconectando…",
    } as Record<string, string>,
  },
  en: {
    title: "Cota Chip Board",
    sub: "Daily tournament · BTC index",
    today: "Today",
    rounds: "Rounds",
    rank: "Rank",
    tapAdds: "Tap adds",
    remove: "Remove 10",
    dflt: "Default spread",
    clear: "Clear",
    inHand: "In hand",
    tourney: "Today's tournament",
    yourRounds: "Your rounds",
    emptyRounds: "Results land here when each round closes.",
    emptyBoard: "Nobody has closed a round today.",
    you: "you",
    anon: "player",
    lbNote: (q: number, n: number) =>
      `* needs ${q} rounds to qualify for prizes (you: ${n}/${q}). Resets at midnight Mexico City.`,
    rulesTitle: "Why it's hard to cheat",
    rules: (q: number) => [
      <>
        Chips <b>lock a full minute</b> before the price that scores them, so a
        faster feed buys nothing.
      </>,
      <>
        Scored on a <b>blended index of several exchanges</b> at the close, not
        one Perpl trade.
      </>,
      <>
        <b>No odds to beat.</b> Copying the default spread scores exactly 0; you
        only gain by reading the market better.
      </>,
      <>
        <b>No index price at the close? The round is void,</b> not paid.
      </>,
      <>
        Ranked over <b>{q}+ rounds</b>, ID-verified accounts only, so lucky
        one-offs and extra accounts don&apos;t win.
      </>,
    ],
    kicker: "New game",
    h1: (
      <>
        Stack your chips where <em>BTC lands</em>
      </>
    ),
    steps: [
      "Every round has a column of price bands standing at its closing time, one minute after the round locks. You get 100 chips per round.",
      "Tap a band to stack chips on it. Pile them up if you're sure, spread them if you're not. Each band shows the points you'd score if BTC closes there.",
      "The round locks after 20 seconds and its column joins the queue. A minute later the price runs into it and you score. A new round opens as soon as one locks.",
    ],
    pitch:
      "More chips on the band where BTC lands means more points, but stacking everything on one band costs a lot when you're wrong. Your best play is to place chips the way you honestly see the odds. It's a daily tournament: everyone plays whenever they like, and the best total wins.",
    go: "Take my first 100 chips",
    fine: (rule: string | null) =>
      `Play points: no value, can't be withdrawn. Each round: 20 s to place, closes 60 s later. Closing price: ${rule ?? "index"}. The server scores; the points on the board are a preview.`,
    round: "ROUND",
    locksIn: (s: string) => `locks in ${s}s`,
    caption: (hold: number) =>
      `closes ${hold}s after it locks · pts if it lands here →`,
    caption2: (band: number, sigma: number) =>
      `band $${band} · σ ${sigma.toFixed(1)} · points are a preview`,
    now: "NOW",
    waiting: "Waiting for the next round…",
    closedAt: (n: string, p: string) => `Round ${n} closed at ${p}`,
    voidToast: "Round void",
    pts: "pts",
    rowClosed: (n: string, p: string) => `R${n} · closed ${p}`,
    rowVoid: (n: string) => `R${n} · void`,
    onWinning: (mine: number, base: number) =>
      `${mine} of your chips were on the winning band (default spread: ${base})`,
    voidWhy: (r: string, phase?: string) =>
      `${VOID_EN[r] ?? r}${phase === "lock" ? " (at lock)" : phase === "close" ? " (at the close)" : ""}. Not scored.`,
    conn: {
      connecting: "connecting",
      live: "live",
      reconnecting: "reconnecting",
      signin: "signed out",
      inactive: "inactive",
      replaced: "in another tab",
      unavailable: "unavailable",
      authfail: "no access",
    } satisfies Record<Conn, string>,
    signInTitle: "Sign in to play",
    signIn: "Sign in with your passkey to get your chips.",
    signInBtn: "Sign in",
    replacedTitle: "You opened the board in another tab",
    replaced:
      "One connection per player. Your chips are safe on the server; you can keep playing here.",
    playHere: "Play here",
    unavailable: "The game server isn't answering. Retrying on our own…",
    authfail:
      "The game server refused this session. Reload the page; if it keeps happening, tell us.",
    inactive: "Your account isn't active.",
    reload: "Reload",
    refused: {
      round_locked: "That round has locked.",
      round_unknown: "That round no longer takes chips.",
      over_100: "You only have 100 chips per round.",
      bad_band: "That move isn't valid.",
      bad_message: "That move isn't valid.",
      rate_limited: "Slow down.",
      offline: "Offline. Reconnecting…",
    } as Record<string, string>,
  },
};

const VOID_ES: Record<string, string> = {
  price_unavailable: "No hubo precio del índice",
  composite_venues: "Muy pocas casas con precio fresco",
  perpl_stale: "El precio de Perpl estaba viejo",
  divergence: "El precio se alejó demasiado del índice",
  sigma_warmup: "Calentando: faltan precios para medir σ",
  missed_close: "El cierre no se registró a tiempo",
};
const VOID_EN: Record<string, string> = {
  price_unavailable: "No index price",
  composite_venues: "Too few exchanges with a fresh price",
  perpl_stale: "Perpl's price was stale",
  divergence: "The price strayed too far from the index",
  sigma_warmup: "Warming up: not enough prices to size the bands",
  missed_close: "The close was not recorded in time",
};

interface LbRow {
  rank: number;
  alias: string | null;
  points: number;
  rounds: number;
  qualified: boolean;
  me: boolean;
}
interface Lb {
  players: number;
  qualifyRounds: number;
  rows: LbRow[];
}

const CHIP = ["#ff9f1c", "#e4007c", "#3ee6a8"];
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Round ids count 20 s periods since 1970; the last three digits are enough on screen. */
const short = (id: number) => String(id % 1000).padStart(3, "0");
const fmtP = (p: number) =>
  p.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
  });

/**
 * The default spread as it stands now, for the PREVIEW column only: centred on
 * the last price, spread over the time left to the lock plus the hold. The
 * server fixes the real baseline at the lock price when the round locks.
 */
function previewBase(s: GameState, o: RoundView, now: number): number[] {
  const p = lastPrice(s) ?? o.openPrice;
  const toLock = Math.max(0, (o.lock - now) / 1000);
  const sd = o.sigma * Math.sqrt(s.holdMs / 1000 + toLock);
  return baseline(o.edges, p, Math.max(1e-6, sd));
}

/** What the DOM around the canvas shows, copied out of the game ref. */
interface Panel {
  hasOpen: boolean;
  placed: number;
  standing: GameState["standing"];
  history: HistoryEntry[];
  refusal: string | null;
  handFlash: boolean;
  rule: string | null;
  qualifyRounds: number;
  closes: number;
}
const EMPTY_PANEL: Panel = {
  hasOpen: false,
  placed: 0,
  standing: null,
  history: [],
  refusal: null,
  handFlash: false,
  rule: null,
  qualifyRounds: 20,
  closes: 0,
};

/* ============ sound (from the mockup) ============ */
function makeSfx() {
  let ac: AudioContext | null = null;
  const beep = (
    f: number,
    d: number,
    v: number,
    f2: number | null,
    type: OscillatorType = "triangle",
  ) => {
    if (!ac) return;
    const o = ac.createOscillator();
    const gn = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, ac.currentTime);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, ac.currentTime + d);
    gn.gain.setValueAtTime(v, ac.currentTime);
    gn.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + d);
    o.connect(gn).connect(ac.destination);
    o.start();
    o.stop(ac.currentTime + d + 0.02);
  };
  return {
    init() {
      try {
        ac = new AudioContext();
      } catch {
        /* no audio: the game is still playable */
      }
    },
    chip() {
      beep(1800 + Math.random() * 400, 0.04, 0.08, null, "square");
      setTimeout(() => beep(2200, 0.03, 0.05, null, "square"), 30);
    },
    unchip() {
      beep(900, 0.05, 0.06, null);
    },
    win() {
      [660, 880, 1320].forEach((f, i) =>
        setTimeout(() => beep(f, 0.18, 0.12, null), i * 80),
      );
    },
    lose() {
      beep(300, 0.3, 0.12, 150);
    },
  };
}

export function ChipBoard() {
  const lang: Lang = useLocale() === "en" ? "en" : "es";
  const t = T[lang];

  const game = useRef<GameState>(initialState());
  const sock = useRef<WebSocket | null>(null);
  const msgId = useRef(0);
  const sfx = useRef<ReturnType<typeof makeSfx> | null>(null);
  const started = useRef(false);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const appEl = useRef<HTMLDivElement | null>(null);
  const hit = useRef<{
    bx: number;
    colW: number;
    rows: Array<{ i: number; y0: number; y1: number }>;
  } | null>(null);
  const handFlash = useRef(0);
  const lastToast = useRef<number | null>(null);

  const [conn, setConn] = useState<Conn>("connecting");
  const [connGen, setConnGen] = useState(0);
  const [intro, setIntro] = useState(true);
  const [size, setSize] = useState(10);
  const [panel, setPanel] = useState<Panel>(EMPTY_PANEL);
  const [lb, setLb] = useState<Lb | null>(null);
  const [lbAt, setLbAt] = useState(0);

  const serverNow = () => Date.now() + (game.current.skew ?? 0);

  // Called from timers and handlers only, never during render.
  const snapshot = (): Panel => {
    const s = game.current;
    const now = Date.now();
    const o = openRound(s, now + (s.skew ?? 0));
    return {
      hasOpen: !!o,
      placed: o ? sum(o.chips) : 0,
      standing: s.standing,
      history: s.history.slice(0, 12),
      refusal: s.refusal && now - s.refusal.at < 3500 ? s.refusal.reason : null,
      handFlash: now - handFlash.current < 600,
      rule: s.rule,
      qualifyRounds: s.qualifyRounds,
      closes: s.closes,
    };
  };
  const snapRef = useRef(snapshot);
  useEffect(() => {
    snapRef.current = snapshot;
  });

  // ---- connection
  useEffect(() => {
    let stopped = false;
    let attempt = 0;
    let authFails = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setInterval> | undefined;

    const schedule = (state: Conn) => {
      if (stopped) return;
      setConn(state);
      const d =
        Math.min(30_000, 1_000 * 2 ** attempt) * (0.5 + Math.random() / 2);
      attempt++;
      retry = setTimeout(() => void connect(), d);
    };

    async function connect() {
      if (stopped) return;
      let res: Response;
      try {
        res = await fetch("/api/chipboard/token", {
          method: "POST",
          cache: "no-store",
        });
      } catch {
        return schedule("reconnecting");
      }
      if (stopped) return;
      if (res.status === 401) return setConn("signin");
      if (res.status === 403) return setConn("inactive");
      if (!res.ok)
        return schedule(res.status === 503 ? "unavailable" : "reconnecting");
      const body = (await res.json().catch(() => null)) as {
        token?: string;
        wsUrl?: string;
      } | null;
      if (stopped) return;
      if (!body?.token || !body.wsUrl) return schedule("unavailable");
      const token = body.token;

      let ws: WebSocket;
      try {
        ws = new WebSocket(body.wsUrl);
      } catch {
        return schedule("unavailable");
      }
      sock.current = ws;
      let lastMsg = Date.now();
      ws.onopen = () => ws.send(JSON.stringify({ t: "auth", token }));
      ws.onmessage = (ev) => {
        lastMsg = Date.now();
        if (typeof ev.data !== "string") return;
        for (const m of parseFrame(ev.data)) {
          apply(game.current, m, Date.now());
          if (m.t === "hello") {
            attempt = 0;
            authFails = 0;
            setConn("live");
          }
        }
      };
      // The server sends a price at least once a second; silence means the
      // connection is dead even if the socket has not noticed.
      watchdog = setInterval(() => {
        if (Date.now() - lastMsg > 10_000) ws.close();
      }, 2_000);
      ws.onclose = (ev) => {
        clearInterval(watchdog);
        if (sock.current === ws) sock.current = null;
        if (stopped) return;
        if (ev.code === 4001) return setConn("replaced");
        if (ev.code === 4003 && ++authFails >= 3) return setConn("authfail");
        schedule("reconnecting");
      };
    }

    void connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(watchdog);
      sock.current?.close(1000);
      sock.current = null;
    };
  }, [connGen]);

  const send = useCallback((m: Record<string, unknown>) => {
    const ws = sock.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      game.current.refusal = { reason: "offline", at: Date.now() };
      return false;
    }
    ws.send(JSON.stringify(m));
    return true;
  }, []);

  // ---- leaderboard: on connect, then after each close
  const closes = panel.closes;
  useEffect(() => {
    if (conn !== "live") return;
    let alive = true;
    const id = setTimeout(async () => {
      try {
        const r = await fetch("/api/chipboard/leaderboard", {
          cache: "no-store",
        });
        if (r.ok && alive) setLb((await r.json()) as Lb);
      } catch {
        /* keep the last board */
      }
    }, 800);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [conn, closes, lbAt]);
  useEffect(() => {
    const id = setInterval(() => setLbAt((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // ---- side panel refresh, like the mockup's ui() every 200 ms
  useEffect(() => {
    const id = setInterval(() => setPanel(snapRef.current()), 200);
    return () => clearInterval(id);
  }, []);

  // ---- placement

  const place = (
    o: RoundView,
    chips: number[],
    msg: Record<string, unknown>,
  ) => {
    const id = ++msgId.current;
    if (!send({ ...msg, id, round: o.id })) return;
    o.lastSent = id;
    o.chips = chips;
    setPanel(snapshot());
  };

  const onPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const h = hit.current;
    if (!started.current || !h) return;
    const o = openRound(game.current, serverNow());
    if (!o) return;
    const b = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - b.left;
    const y = e.clientY - b.top;
    if (x < h.bx || x > h.bx + h.colW) return;
    const row = h.rows.find((r) => y >= r.y0 && y < r.y1);
    if (!row) return;
    const chips = [...o.chips];
    if (size > 0) {
      const add = Math.min(size, CHIPS - sum(chips));
      if (add <= 0) {
        handFlash.current = Date.now();
        setPanel(snapshot());
        return;
      }
      chips[row.i] += add;
      place(o, chips, { t: "add", band: row.i, delta: add });
      sfx.current?.chip();
    } else {
      if (chips[row.i] <= 0) return;
      chips[row.i] = Math.max(0, chips[row.i] + size);
      place(o, chips, { t: "add", band: row.i, delta: size });
      sfx.current?.unchip();
    }
  };

  const onDefault = () => {
    const o = openRound(game.current, serverNow());
    if (!o) return;
    const c = defaultSpread(previewBase(game.current, o, serverNow()));
    place(o, c, { t: "set", chips: c });
    sfx.current?.chip();
  };
  const onClear = () => {
    const o = openRound(game.current, serverNow());
    if (!o) return;
    const c = new Array<number>(NB).fill(0);
    place(o, c, { t: "set", chips: c });
  };

  // The draw loop is set up once and reads the copy through this ref.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  });

  // ---- drawing (ported from the mockup's draw())
  useEffect(() => {
    const cv = canvas.current;
    const bx0 = box.current;
    if (!cv || !bx0) return;
    const g = cv.getContext("2d");
    if (!g) return;
    let W = 0;
    let H = 0;
    let vC = 0;
    let raf = 0;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = bx0.clientWidth;
      H = bx0.clientHeight;
      cv.width = W * dpr;
      cv.height = H * dpr;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(bx0);
    resize();
    const numFont = () =>
      (appEl.current &&
        getComputedStyle(appEl.current).getPropertyValue("--f-num").trim()) ||
      '"JetBrains Mono", monospace';
    let FN = numFont();
    const fontTimer = setTimeout(() => (FN = numFont()), 1500);

    const drawStack = (x: number, y: number, n: number, maxW: number) => {
      // one disc per 5 chips, in rows of up to maxW/9, colour by layer
      const discs = Math.ceil(n / 5);
      const per = Math.max(1, Math.floor(maxW / 9));
      for (let k = 0; k < discs; k++) {
        const col = k % per;
        const row = Math.floor(k / per);
        g.fillStyle = CHIP[row % 3];
        g.beginPath();
        g.ellipse(x + 6 + col * 9, y - row * 3, 5, 3.2, 0, 0, 7);
        g.fill();
        g.strokeStyle = "rgba(18,10,42,0.6)";
        g.stroke();
      }
    };

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const s = game.current;
      const now = Date.now() + (game.current.skew ?? 0);
      const localNow = Date.now();
      const last = lastPrice(s);
      const o = openRound(s, now);
      // The reference column: the open round, else the newest live one.
      const ref =
        o ??
        [...s.rounds].reverse().find((r) => r.status === "locked") ??
        s.rounds[s.rounds.length - 1] ??
        null;
      const band = ref?.band ?? 25;
      const center =
        ref?.centre ?? (last !== null ? Math.round(last / band) * band : 0);
      const nowX = W * (W < 600 ? 0.18 : 0.3);
      const colW = clamp(W * (W < 600 ? 0.42 : 0.24), 150, 240);
      const futPx = W - nowX - colW / 2 - 64;
      const horizon = s.openMs + s.holdMs;
      const X = (tt: number) => nowX + ((tt - now) / horizon) * futPx;
      const rowH = (H - 76) / 11; // 10 bands + two half-height tails
      vC = lerp(vC || center, center, 0.08);
      const Y = (p: number) => H / 2 + 8 - ((p - vC) / band) * rowH;

      g.fillStyle = "#100926";
      g.fillRect(0, 0, W, H);
      if (!W || !H) return;

      // price grid
      g.font = `500 11px ${FN}`;
      g.textAlign = "right";
      if (last !== null || ref)
        for (let k = -8; k <= 8; k++) {
          const p = center + k * band;
          const y = Y(p);
          if (y < 0 || y > H) continue;
          g.strokeStyle = "rgba(255,255,255,0.04)";
          g.beginPath();
          g.moveTo(0, y);
          g.lineTo(W, y);
          g.stroke();
          g.fillStyle = "rgba(179,167,201,0.6)";
          g.fillText(p.toLocaleString("en-US"), W - 6, y - 3);
        }

      // locked / settled / void rounds: thin columns at their closing times
      for (const r of s.rounds) {
        if (r === o || (r.status === "open" && now < r.lock)) continue;
        const x = X(r.close);
        if (x < -20 || x > W) continue;
        const w = 18;
        const fl =
          s.flash && s.flash.round === r.id
            ? clamp(1 - (localNow - s.flash.at) / 2500, 0, 1)
            : 0;
        const q = r.baseline ? shares(r.confirmed, r.baseline) : null;
        const isVoid = r.status === "void";
        for (let i = 1; i <= 10; i++) {
          const y1 = Y(r.edges[i]);
          const y0 = Y(r.edges[i - 1]);
          const landed = r.status === "settled" && r.landed === i;
          g.fillStyle = isVoid
            ? "rgba(179,167,201,0.08)"
            : landed
              ? `rgba(62,230,168,${0.4 + 0.5 * fl})`
              : `rgba(255,159,28,${0.08 + (q ? q[i] : 0) * 1.4})`;
          g.fillRect(x - w / 2, y1 + 1, w, y0 - y1 - 2);
        }
        const pts = r.result?.points;
        g.strokeStyle = isVoid
          ? "rgba(179,167,201,0.45)"
          : r.status === "settled"
            ? pts === undefined || pts >= 0
              ? "rgba(62,230,168,0.7)"
              : "rgba(228,0,124,0.7)"
            : "rgba(255,159,28,0.5)";
        if (isVoid) g.setLineDash([3, 3]);
        g.strokeRect(
          x - w / 2,
          Y(r.edges[10]),
          w,
          Y(r.edges[0]) - Y(r.edges[10]),
        );
        g.setLineDash([]);
        g.fillStyle = "rgba(246,239,228,0.75)";
        g.textAlign = "center";
        g.font = `700 10px ${FN}`;
        g.fillText(
          isVoid
            ? "VOID"
            : r.status === "settled"
              ? pts !== undefined
                ? sgn(pts)
                : "–"
              : `R${short(r.id)}`,
          x,
          Y(r.edges[10]) - 6,
        );
        if (r.status === "locked") {
          g.fillStyle = "rgba(179,167,201,0.7)";
          g.fillText(
            `${Math.max(0, Math.ceil((r.close - now) / 1000))}s`,
            x,
            Y(r.edges[0]) + 14,
          );
        }
      }

      // the index line (past) up to NOW
      if (last !== null) {
        g.lineWidth = 2.4;
        g.strokeStyle = "#ffb347";
        g.beginPath();
        let first = true;
        const tL = now - (nowX / futPx) * horizon;
        for (const pt of s.px) {
          if (pt.t < tL) continue;
          const x = Math.min(X(pt.t), nowX);
          if (first) g.moveTo(x, Y(pt.p));
          else g.lineTo(x, Y(pt.p));
          first = false;
        }
        g.lineTo(nowX, Y(last));
        g.stroke();
        g.lineWidth = 1;
      }
      g.strokeStyle = "rgba(255,209,102,0.5)";
      g.setLineDash([3, 5]);
      g.beginPath();
      g.moveTo(nowX, 0);
      g.lineTo(nowX, H);
      g.stroke();
      g.setLineDash([]);
      if (last !== null) {
        const pulse = 0.5 + 0.5 * Math.sin(localNow / 170);
        g.fillStyle = "#ffd166";
        g.beginPath();
        g.arc(nowX, Y(last), 4 + 3 * pulse, 0, 7);
        g.fill();
        g.textAlign = "right";
        g.font = `700 12px ${FN}`;
        const ptx = fmtP(last);
        const tw = g.measureText(ptx).width + 12;
        g.fillStyle = "#ffd166";
        g.beginPath();
        // Kept on the canvas on narrow screens, where NOW sits near the edge.
        const tagX = Math.max(2, nowX - tw - 8);
        g.roundRect(tagX, Y(last) - 10, tw, 20, 5);
        g.fill();
        g.fillStyle = "#120a2a";
        g.fillText(ptx, tagX + tw - 6, Y(last) + 4);
      }
      g.textAlign = "center";
      g.fillStyle = "rgba(246,239,228,0.6)";
      g.font = `500 11px ${FN}`;
      g.fillText(tRef.current.now, nowX, H - 6);

      // the open round: the board you stack on
      if (!o) {
        hit.current = null;
        g.textAlign = "center";
        g.fillStyle = "rgba(179,167,201,0.85)";
        g.font = `700 13px ${FN}`;
        g.fillText(tRef.current.waiting, nowX + (W - nowX) / 2, H / 2);
      } else {
        const cx = X(o.close);
        const bx = cx - colW / 2;
        const top = Y(o.edges[10]) - rowH / 2;
        const bot = Y(o.edges[0]) + rowH / 2;
        g.fillStyle = "rgba(26,16,56,0.94)";
        g.strokeStyle = "rgba(255,159,28,0.55)";
        g.lineWidth = 1.5;
        g.beginPath();
        g.roundRect(bx, top - 4, colW, bot - top + 8, 10);
        g.fill();
        g.stroke();
        g.lineWidth = 1;
        const base = previewBase(s, o, now);
        const rows: Array<{ i: number; y0: number; y1: number }> = [];
        const lastBand = last !== null ? bandOf(o.edges, last) : -1;
        for (let i = NB - 1; i >= 0; i--) {
          const yTop = i === 11 ? top : Y(o.edges[i]);
          const yBot = i === 0 ? bot : Y(o.edges[i - 1]);
          rows.push({ i, y0: yTop, y1: yBot });
          g.fillStyle =
            lastBand === i
              ? "rgba(255,209,102,0.10)"
              : i % 2
                ? "rgba(255,255,255,0.025)"
                : "rgba(255,255,255,0)";
          g.fillRect(bx + 2, yTop + 1, colW - 4, yBot - yTop - 2);
          g.strokeStyle = "rgba(255,255,255,0.06)";
          g.beginPath();
          g.moveTo(bx + 4, yBot);
          g.lineTo(bx + colW - 4, yBot);
          g.stroke();
          const mid = (yTop + yBot) / 2;
          g.textAlign = "left";
          g.font = `500 10px ${FN}`;
          g.fillStyle = "rgba(179,167,201,0.85)";
          const label =
            i === 0
              ? `< ${o.edges[0].toLocaleString("en-US")}`
              : i === 11
                ? `≥ ${o.edges[10].toLocaleString("en-US")}`
                : o.edges[i - 1].toLocaleString("en-US");
          if (colW > 170) g.fillText(label, bx + 8, mid + 4);
          if (o.chips[i] > 0)
            drawStack(
              bx + (colW > 170 ? 76 : 6),
              mid + 3,
              o.chips[i],
              colW - (colW > 170 ? 130 : 60),
            );
          g.textAlign = "right";
          g.font = `700 11px ${FN}`;
          const pv = previewPoints(o.chips, base, i);
          g.fillStyle =
            pv > 0 ? "#3ee6a8" : pv < 0 ? "#e4007c" : "rgba(179,167,201,0.7)";
          g.fillText(sgn(pv), bx + colW - 8, mid + 4);
          if (o.chips[i] > 0) {
            g.fillStyle = "#f6efe4";
            g.font = `700 10px ${FN}`;
            g.fillText(String(o.chips[i]), bx + colW - 44, mid + 4);
          }
        }
        hit.current = { bx, colW, rows };
        // header over the board
        const secs = Math.max(0, (o.lock - now) / 1000);
        g.textAlign = "center";
        g.fillStyle = secs < 4 ? "#e4007c" : "#ff9f1c";
        g.font = `800 13px ${FN}`;
        g.fillText(
          `${tRef.current.round} ${short(o.id)} · ${tRef.current.locksIn(secs.toFixed(1))}`,
          cx,
          top - 12,
        );
        g.fillStyle = "rgba(179,167,201,0.85)";
        g.font = `500 10px ${FN}`;
        const capLines = [
          tRef.current.caption(Math.round(s.holdMs / 1000)),
          tRef.current.caption2(o.band, o.sigma),
        ];
        capLines.forEach((line, k) => {
          const half = g.measureText(line).width / 2;
          g.fillText(
            line,
            clamp(cx, half + 4, W - half - 4),
            bot + 18 + k * 13,
          );
        });
      }

      // toast
      const toast = s.toast;
      if (toast && localNow - toast.at < 2400) {
        const a = clamp((2400 - (localNow - toast.at)) / 500, 0, 1);
        g.globalAlpha = a;
        g.textAlign = "center";
        const tx = nowX * 0.5 + 40;
        if (toast.kind === "void") {
          g.font = `800 26px ${FN}`;
          g.fillStyle = "#b3a7c9";
          g.fillText(tRef.current.voidToast, tx, H * 0.22);
          g.font = `500 12px ${FN}`;
          g.fillStyle = "#f6efe4";
          g.fillText(
            `R${short(toast.round)} · ${tRef.current.voidWhy(toast.reason ?? "")}`,
            tx,
            H * 0.22 + 22,
          );
        } else {
          g.font = `800 34px ${FN}`;
          g.fillStyle = toast.kind === "win" ? "#3ee6a8" : "#e4007c";
          g.fillText(
            `${sgn(toast.points ?? 0)} ${tRef.current.pts}`,
            tx,
            H * 0.22,
          );
          g.font = `500 12px ${FN}`;
          g.fillStyle = "#f6efe4";
          g.fillText(
            tRef.current.closedAt(short(toast.round), fmtP(toast.price ?? 0)),
            tx,
            H * 0.22 + 22,
          );
        }
        g.globalAlpha = 1;
      }
      // a sound once per new toast
      if (toast && toast.at !== lastToast.current) {
        lastToast.current = toast.at;
        if (started.current && toast.kind !== "void")
          sfx.current?.[toast.kind === "win" ? "win" : "lose"]();
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(fontTimer);
      ro.disconnect();
    };
    // The loop reads everything through refs; it is set up once.
  }, []);

  // ---- render
  const placed = panel.placed;
  const st = panel.standing;
  const pts = st?.points ?? 0;
  const myRounds = st?.rounds ?? 0;
  const q = st?.qualifyRounds ?? lb?.qualifyRounds ?? panel.qualifyRounds;
  const refusal = panel.refusal
    ? (t.refused[panel.refusal] ?? t.refused.bad_message)
    : null;

  const reconnect = () => {
    setConn("connecting");
    setConnGen((n) => n + 1);
  };

  const startGame = () => {
    started.current = true;
    if (!sfx.current) {
      sfx.current = makeSfx();
      sfx.current.init();
    }
    setIntro(false);
  };

  const blocking =
    conn === "signin" ||
    conn === "replaced" ||
    conn === "authfail" ||
    conn === "inactive";

  return (
    <div className={css.app} ref={appEl}>
      <div className={css.top}>
        <div className={css.brand}>
          <b>{t.title}</b>
          <span>{t.sub}</span>
        </div>
        <div className={css.kpis}>
          <div className={css.kpi}>
            <small>{t.today}</small>
            <strong
              style={{
                color:
                  pts > 0 ? "var(--mint)" : pts < 0 ? "var(--rosa)" : undefined,
              }}
            >
              {sgn(pts)}
            </strong>
          </div>
          <div className={css.kpi}>
            <small>{t.rounds}</small>
            <strong>{myRounds}</strong>
          </div>
          <div className={css.kpi}>
            <small>{t.rank}</small>
            <strong>{st ? `${st.rank}/${st.players}` : "–"}</strong>
          </div>
          <span className={css.conn} data-state={conn} role="status">
            {t.conn[conn]}
          </span>
          <LanguageSwitch className={css.langTop} />
        </div>
      </div>

      <div className={css.board} ref={box}>
        <canvas
          ref={canvas}
          onPointerDown={onPointer}
          aria-label={
            lang === "es"
              ? "Tablero de fichas: toca una banda de precio de la ronda abierta para apilar fichas"
              : "Chip board: tap a price band in the open round to stack chips on it"
          }
        />
      </div>

      <div className={css.ctl}>
        <span className={css.lbl}>{t.tapAdds}</span>
        <div className={css.seg}>
          {[5, 10, 25, -10].map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={size === n}
              onClick={() => setSize(n)}
            >
              {n > 0 ? n : t.remove}
            </button>
          ))}
        </div>
        <button
          className={css.plain}
          type="button"
          onClick={onDefault}
          disabled={!panel.hasOpen}
        >
          {t.dflt}
        </button>
        <button
          className={css.plain}
          type="button"
          onClick={onClear}
          disabled={!panel.hasOpen}
        >
          {t.clear}
        </button>
        <div className={css.hand}>
          {t.inHand}: <span data-flash={panel.handFlash}>{CHIPS - placed}</span>{" "}
          / {CHIPS}
        </div>
        <div className={css.refusal} role="alert">
          {refusal ?? ""}
        </div>
      </div>

      <aside className={css.side}>
        <div className={css.lb}>
          <h3>{t.tourney}</h3>
          {lb && lb.rows.length ? (
            <ol>
              {lb.rows.map((r) => (
                <li key={`${r.rank}`} className={r.me ? css.me : undefined}>
                  <span>{r.rank}</span>
                  <span className={!r.me && !r.alias ? css.anon : undefined}>
                    {r.me
                      ? r.alias
                        ? `${r.alias} (${t.you})`
                        : t.you
                      : (r.alias ?? `${t.anon} ${r.rank}`)}
                    {r.qualified ? "" : " *"}
                  </span>
                  <span>{sgn(r.points)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <div className={css.empty}>{t.emptyBoard}</div>
          )}
          <div className={css.note}>{t.lbNote(q, myRounds)}</div>
        </div>
        <div>
          <h3>{t.yourRounds}</h3>
          <div className={css.rounds}>
            {panel.history.length ? (
              panel.history.map((h) =>
                h.voidReason ? (
                  <div className={css.rd} key={`v${h.round}`}>
                    <span>{t.rowVoid(short(h.round))}</span>
                    <span className={css.r} style={{ color: "var(--muted)" }}>
                      –
                    </span>
                    <small>{t.voidWhy(h.voidReason, h.voidPhase)}</small>
                  </div>
                ) : (
                  <div className={css.rd} key={`s${h.round}`}>
                    <span>
                      {t.rowClosed(short(h.round), fmtP(h.price ?? 0))}
                    </span>
                    <span
                      className={css.r}
                      style={{
                        color:
                          (h.points ?? 0) >= 0 ? "var(--mint)" : "var(--rosa)",
                      }}
                    >
                      {sgn(h.points ?? 0)}
                    </span>
                    {h.baseline && h.chips && h.landed !== undefined ? (
                      <small>
                        {t.onWinning(
                          Math.round(
                            shares(h.chips, h.baseline)[h.landed] * 100,
                          ),
                          Math.round(h.baseline[h.landed] * 100),
                        )}
                      </small>
                    ) : null}
                  </div>
                ),
              )
            ) : (
              <div className={css.empty}>{t.emptyRounds}</div>
            )}
          </div>
        </div>
        <LanguageSwitch className={css.langSide} />
        <div className={css.rulesBox}>
          <h3>{t.rulesTitle}</h3>
          <div className={css.rules}>
            {t.rules(q).map((r, i) => (
              <div key={i}>
                <span>{r}</span>
              </div>
            ))}
          </div>
        </div>
      </aside>

      {blocking ? (
        <div className={css.overlay}>
          <div className={css.card}>
            <div className={css.kicker}>{t.title}</div>
            {conn === "signin" ? (
              <>
                <h2>{t.signInTitle}</h2>
                <p>{t.signIn}</p>
                <SignInPrompt label={t.signInBtn} onSignedIn={reconnect} />
              </>
            ) : conn === "replaced" ? (
              <>
                <h2>{t.replacedTitle}</h2>
                <p>{t.replaced}</p>
                <button className={css.go} type="button" onClick={reconnect}>
                  {t.playHere}
                </button>
              </>
            ) : (
              <>
                <p>{conn === "inactive" ? t.inactive : t.authfail}</p>
                <button
                  className={css.go}
                  type="button"
                  onClick={() => window.location.reload()}
                >
                  {t.reload}
                </button>
              </>
            )}
          </div>
        </div>
      ) : intro ? (
        <div className={css.overlay}>
          <div className={css.card}>
            <div className={css.kicker}>{t.kicker}</div>
            <h1>{t.h1}</h1>
            <div className={css.steps3}>
              {t.steps.map((step, i) => (
                <span key={i} style={{ display: "contents" }}>
                  <i>{i + 1}</i>
                  <span>{step}</span>
                </span>
              ))}
            </div>
            <p>{t.pitch}</p>
            <button className={css.go} type="button" onClick={startGame}>
              {t.go}
            </button>
            <div className={css.fine}>
              {conn === "unavailable" ? t.unavailable : t.fine(panel.rule)}
            </div>
          </div>
        </div>
      ) : conn === "unavailable" ? (
        <div className={css.overlay}>
          <div className={css.card}>
            <div className={css.kicker}>{t.title}</div>
            <p>{t.unavailable}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
