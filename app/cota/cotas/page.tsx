"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { Button, LinkButton, Note, Panel, Stat } from "@/components/ui/primitives";
import { LanguageSwitch } from "@/components/hunt/LanguageSwitch";

// ---------------------------------------------------------------------------
// Cotas — the play-money wall game.
//
// Everything on this screen is drawn from /api/cotas. The page holds the walls
// a player is dragging and nothing else: prices, fills and chips arrive from
// the server, which computes them from Perpl's real MON trades. A wall the
// server refuses snaps back to where the server has it.
// ---------------------------------------------------------------------------

type Lang = "es" | "en";

interface Walls {
  lo: number;
  hi: number;
}
interface Recent {
  id: string;
  kind: string;
  side: number | null;
  price: number | null;
  entry: number | null;
  qty: number | null;
  pnl: number | null;
  fee: number | null;
  balanceAfter: number;
  candleAt: number;
}
interface View {
  price: number;
  walls: Walls | null;
  leash: { long: number; short: number } | null;
  qty: number;
  next: number | null;
  sizes: number[];
  pos: 0 | 1 | -1;
  entry: number;
  armed: boolean;
  balance: number;
  openPnl: number;
  crossings: number;
  escapes: number;
  streak: number;
  bestStreak: number;
  fees: number;
  canRefill: boolean;
  trail: Array<{ t: number; p: number }>;
  recent: Recent[];
}

const T = {
  es: {
    back: "Cota",
    title: "Cotas",
    lede: "Pon una cota abajo y otra arriba. El precio real de MON en Perpl rebota entre ellas: cada cruce de una pared a la otra gana la distancia; si se escapa hasta tu correa, pierdes.",
    play: "Fichas de juego: sin valor, no se retiran. Los precios son operaciones reales de Perpl, minuto a minuto.",
    signIn: "Inicia sesión en Hunt para jugar.",
    feed: "No se pudo leer el precio de Perpl. Reintentando…",
    place: "Poner paredes",
    squeeze: "Apretar",
    widen: "Abrir",
    down: "Quitar paredes",
    refill: "Recargar 1,000 fichas",
    size: "Tamaño por atrapada",
    sizeLocked: (now: string, next: string | null) =>
      next
        ? `Esta atrapada sigue en ${now} MON; la siguiente será de ${next} MON.`
        : `Esta atrapada sigue en ${now} MON. Elige un tamaño para la siguiente.`,
    chips: "Fichas",
    open: "Abierta",
    crossings: "Cruces",
    escapes: "Escapes",
    streak: "Racha",
    fees: "Comisiones",
    board: "Tabla semanal →",
    log: "Lo que pasó",
    none: "Todavía nada. Pon tus paredes y espera a que el precio toque una.",
    holdingLong: "Comprado: sale en la pared de arriba",
    holdingShort: "Vendido: sale en la pared de abajo",
    armed: "Paredes listas",
    waiting: "Esperando que el precio vuelva entre las paredes",
    noWalls: "Sin paredes",
    gap: (g: string, per: string) => `${g} entre paredes · ${per} por cruce`,
    ev: {
      grant: (c: string) => `Recibiste ${c} fichas para jugar.`,
      refill: (c: string) => `Recarga: +${c} fichas.`,
      open: (side: number, p: string, q: number) =>
        `El precio tocó la pared de ${side > 0 ? "abajo: compraste" : "arriba: vendiste"} ${q.toLocaleString("es-MX")} MON a ${p}.`,
      cross: (pnl: string) =>
        `¡Cruce! Cerró en la otra pared: ${pnl} tras comisiones.`,
      escape: (pnl: string) =>
        `Escape: el precio atravesó tu pared hasta la correa. ${pnl} tras comisiones. Las paredes se recentraron.`,
    },
    refused: {
      price_not_between: "El precio tiene que quedar entre las paredes.",
      gap_too_small: "Las paredes están demasiado juntas (mínimo 0.10%).",
      gap_too_wide: "Las paredes están demasiado separadas (máximo 2%).",
      exit_wrong_side: "La salida tiene que quedar del otro lado del precio.",
      insufficient_chips: "No te alcanzan las fichas para ese tamaño.",
      default: "No se pudo mover la pared.",
    } as Record<string, string>,
  },
  en: {
    back: "Cota",
    title: "Cotas",
    lede: "Set one cota below and one above. MON's real price on Perpl bounces between them: every crossing from one wall to the other earns the gap; if it escapes to your leash, you lose.",
    play: "Play chips: no value, can't be withdrawn. Prices are real Perpl trades, minute by minute.",
    signIn: "Sign in to Hunt to play.",
    feed: "Couldn't read Perpl's price. Retrying…",
    place: "Place walls",
    squeeze: "Squeeze",
    widen: "Widen",
    down: "Take walls down",
    refill: "Refill 1,000 chips",
    size: "Size per catch",
    sizeLocked: (now: string, next: string | null) =>
      next
        ? `This catch stays ${now} MON; the next one will be ${next} MON.`
        : `This catch stays ${now} MON. Pick a size for the next one.`,
    chips: "Chips",
    open: "Open",
    crossings: "Crossings",
    escapes: "Escapes",
    streak: "Streak",
    fees: "Fees",
    board: "Weekly board →",
    log: "What happened",
    none: "Nothing yet. Place your walls and wait for the price to touch one.",
    holdingLong: "Long: exits at the top wall",
    holdingShort: "Short: exits at the bottom wall",
    armed: "Walls armed",
    waiting: "Waiting for the price to come back between the walls",
    noWalls: "No walls",
    gap: (g: string, per: string) => `${g} apart · ${per} per crossing`,
    ev: {
      grant: (c: string) => `You got ${c} chips to play with.`,
      refill: (c: string) => `Refill: +${c} chips.`,
      open: (side: number, p: string, q: number) =>
        `The price touched the ${side > 0 ? "bottom wall: you bought" : "top wall: you sold"} ${q.toLocaleString("en-US")} MON at ${p}.`,
      cross: (pnl: string) =>
        `Crossing! Closed at the other wall: ${pnl} after fees.`,
      escape: (pnl: string) =>
        `Escape: the price broke through your wall to the leash. ${pnl} after fees. Walls re-centred.`,
    },
    refused: {
      price_not_between: "The price has to sit between the walls.",
      gap_too_small: "Walls too close together (0.10% minimum).",
      gap_too_wide: "Walls too far apart (2% maximum).",
      exit_wrong_side: "The exit has to stay on the far side of the price.",
      insufficient_chips: "Not enough chips for that size.",
      default: "Couldn't move the wall.",
    } as Record<string, string>,
  },
} as const;

const CHIP = 1_000_000;
const MAKER = 29;
const DEN = 100_000;
const chips = (micro: number, lang: Lang, sign = false) => {
  const v = micro / CHIP;
  const s = Math.abs(v).toLocaleString(lang === "es" ? "es-MX" : "en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return sign ? `${v < 0 ? "−" : "+"}${s}` : s;
};
const usd = (p: number) => `$${(p / 1e6).toFixed(6)}`;
const gapOf = (w: Walls) => Math.round(((w.hi - w.lo) * DEN) / w.lo);
const centred = (price: number, gap: number): Walls => {
  const half = Math.round((price * gap) / DEN / 2);
  return { lo: price - half, hi: price + half };
};

const COLORS = {
  void: "#03080a",
  line: "#17343d",
  ink: "#d9f5ec",
  dim: "#78a094",
  wall: "#ffd12e",
  long: "#46ffbe",
  short: "#ff9d2e",
  leash: "#ff3b30",
};

export default function CotasPage() {
  const locale = useLocale();
  const lang: Lang = locale === "en" ? "en" : "es";
  const t = T[lang];

  const [view, setView] = useState<View | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "signin" | "feed">(
    "loading",
  );
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const drag = useRef<{
    which: "lo" | "hi";
    walls: Walls;
    frozen: { c: number; h: number };
  } | null>(null);
  const viewRef = useRef<View | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const flashes = useRef<
    Array<{ text: string; color: string; at: number; price: number }>
  >([]);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const ingest = useCallback(
    (v: View) => {
      // Flash events we have not seen. The first load only records them.
      const ids = new Set(v.recent.map((e) => e.id));
      if (seen.current) {
        for (const e of v.recent) {
          if (seen.current.has(e.id)) continue;
          if (e.kind === "cross")
            flashes.current.push({
              text: chips(e.pnl ?? 0, lang, true),
              color: COLORS.long,
              at: performance.now(),
              price: e.price ?? v.price,
            });
          if (e.kind === "escape")
            flashes.current.push({
              text: chips(e.pnl ?? 0, lang, true),
              color: COLORS.leash,
              at: performance.now(),
              price: e.price ?? v.price,
            });
          if (e.kind === "open")
            flashes.current.push({
              text: e.side && e.side > 0 ? "▲" : "▼",
              color: COLORS.wall,
              at: performance.now(),
              price: e.price ?? v.price,
            });
        }
      }
      seen.current = ids;
      setView(v);
      setStatus("ok");
    },
    [lang],
  );

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/cotas", { cache: "no-store" });
      if (r.status === 401) return setStatus("signin");
      if (r.status === 503) return setStatus("feed");
      if (!r.ok) return;
      ingest((await r.json()) as View);
    } catch {
      /* keep the last screen */
    }
  }, [ingest]);

  useEffect(() => {
    // Past a microtask, so the first load is not a synchronous set-state-in-effect.
    void Promise.resolve().then(load);
    const id = setInterval(() => {
      if (document.visibilityState === "visible" && !drag.current) void load();
    }, 3_000);
    return () => clearInterval(id);
  }, [load]);

  const act = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setMsg(null);
      try {
        const r = await fetch("/api/cotas", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok) ingest(j as View);
        else
          setMsg(
            t.refused[(j as { reason?: string }).reason ?? ""] ??
              t.refused.default,
          );
      } finally {
        setBusy(false);
      }
    },
    [ingest, t],
  );

  const sendWalls = (w: Walls, qty?: number) =>
    act({ action: "walls", lo: w.lo, hi: w.hi, qty: qty ?? view?.qty ?? 1000 });

  const resize = (f: number) => {
    const v = viewRef.current;
    if (!v?.walls) return;
    const g = Math.max(100, Math.min(2_000, Math.round(gapOf(v.walls) * f)));
    if (v.pos === 0)
      return sendWalls(centred(Math.round((v.walls.lo + v.walls.hi) / 2), g));
    if (v.pos > 0)
      return sendWalls({
        lo: v.walls.lo,
        hi: v.walls.lo + Math.round((v.walls.lo * g) / DEN),
      });
    return sendWalls({
      lo: v.walls.hi - Math.round((v.walls.hi * g) / DEN),
      hi: v.walls.hi,
    });
  };

  // ---- drawing: a requestAnimationFrame loop reading the latest view from a ref
  useEffect(() => {
    let raf = 0;
    let center = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const cv = canvas.current;
      const v = viewRef.current;
      if (!cv || !v) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = cv.clientWidth;
      const H = cv.clientHeight;
      if (cv.width !== Math.round(W * dpr)) {
        cv.width = Math.round(W * dpr);
        cv.height = Math.round(H * dpr);
      }
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const walls = drag.current?.walls ?? v.walls;
      const mid = walls ? (walls.lo + walls.hi) / 2 : v.price;
      const target = mid * 0.6 + v.price * 0.4;
      center = center ? center + (target - center) * 0.08 : target;
      const gap = walls ? gapOf(walls) / DEN : 0.004;
      const frozen = drag.current?.frozen;
      const c = frozen ? frozen.c : center;
      const half = frozen ? frozen.h : Math.max(0.009, gap * 3.4) * c;
      const top = 24;
      const bot = H - 20;
      const y = (p: number) =>
        (top + bot) / 2 - ((p - c) / half) * ((bot - top) / 2);
      (cv as HTMLCanvasElement & { _map?: unknown })._map = {
        c,
        half,
        top,
        bot,
      };

      ctx.fillStyle = COLORS.void;
      ctx.fillRect(0, 0, W, H);
      const bx = W * 0.7;
      // trail: 30 minutes of closes, right-aligned to the ball
      if (v.trail.length > 1) {
        const t1 = v.trail[v.trail.length - 1].t;
        ctx.strokeStyle = "rgba(217,245,236,.55)";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        v.trail.forEach((pt, i) => {
          const x = bx - ((t1 - pt.t) / 60_000) * (bx / 30);
          if (i) ctx.lineTo(x, y(pt.p));
          else ctx.moveTo(x, y(pt.p));
        });
        ctx.lineTo(bx, y(v.price));
        ctx.stroke();
      }
      if (walls) {
        const leashLong = walls.lo - (walls.lo * gapOf(walls) * 2) / DEN;
        const leashShort = walls.hi + (walls.hi * gapOf(walls) * 2) / DEN;
        ctx.fillStyle = "rgba(255,209,46,.06)";
        ctx.fillRect(0, y(walls.hi), W, y(walls.lo) - y(walls.hi));
        ctx.setLineDash([4, 6]);
        ctx.strokeStyle = "rgba(255,59,48,.7)";
        ctx.beginPath();
        ctx.moveTo(0, y(leashLong));
        ctx.lineTo(W, y(leashLong));
        ctx.moveTo(0, y(leashShort));
        ctx.lineTo(W, y(leashShort));
        ctx.stroke();
        ctx.setLineDash([]);
        for (const [k, p] of [
          ["hi", walls.hi],
          ["lo", walls.lo],
        ] as const) {
          const active =
            v.pos === 0
              ? v.armed
                ? 1
                : 0.45
              : v.pos > 0 === (k === "hi")
                ? 1
                : 0.35;
          ctx.globalAlpha = active;
          ctx.fillStyle = COLORS.wall;
          ctx.fillRect(0, y(p) - 2, W, 4);
          ctx.globalAlpha = 1;
          const hx = W * 0.3;
          ctx.beginPath();
          ctx.roundRect(hx - 22, y(p) - 11, 44, 22, 11);
          ctx.fill();
          ctx.fillStyle = COLORS.void;
          ctx.font = "700 13px system-ui";
          ctx.textAlign = "center";
          ctx.fillText("⇕", hx, y(p) + 5);
          ctx.textAlign = "right";
          ctx.fillStyle = COLORS.wall;
          ctx.font = "600 11px ui-monospace, monospace";
          ctx.fillText(usd(p), W - 8, k === "hi" ? y(p) - 8 : y(p) + 16);
          ctx.textAlign = "left";
        }
        const per =
          v.qty * (walls.hi - walls.lo) -
          (v.qty * walls.lo * MAKER) / DEN -
          (v.qty * walls.hi * MAKER) / DEN;
        // On a dark plate, under the top wall, so the price line never runs
        // through the words.
        const label = t.gap(`${(gapOf(walls) / 1000).toFixed(2)}%`, chips(per, lang, true));
        ctx.font = "600 11px ui-monospace, monospace";
        const ly = y(walls.hi) - 22;
        ctx.fillStyle = "rgba(3,8,10,.85)";
        ctx.fillRect(4, ly - 12, ctx.measureText(label).width + 10, 17);
        ctx.fillStyle = "rgba(255,209,46,.95)";
        ctx.fillText(label, 9, ly);
      }
      if (v.pos !== 0) {
        ctx.strokeStyle = v.openPnl >= 0 ? COLORS.long : COLORS.leash;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(bx + 20, y(v.entry));
        ctx.lineTo(bx + 20, y(v.price));
        ctx.stroke();
        ctx.fillStyle = v.openPnl >= 0 ? COLORS.long : COLORS.leash;
        ctx.font = "600 12px system-ui";
        ctx.fillText(
          chips(v.openPnl, lang, true),
          bx + 28,
          (y(v.entry) + y(v.price)) / 2 + 4,
        );
      }
      const col =
        v.pos > 0 ? COLORS.long : v.pos < 0 ? COLORS.short : COLORS.ink;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(bx, y(v.price), 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = "500 10px ui-monospace, monospace";
      ctx.fillStyle = COLORS.ink;
      ctx.textAlign = "center";
      // Above the ball when it sits near the bottom wall, below it otherwise.
      const below = !walls || Math.abs(y(v.price) + 22 - y(walls.lo)) > 12;
      const py = below ? y(v.price) + 24 : y(v.price) - 16;
      const pl = `MON ${usd(v.price)}`;
      ctx.fillStyle = "rgba(3,8,10,.85)";
      ctx.fillRect(bx - ctx.measureText(pl).width / 2 - 4, py - 11, ctx.measureText(pl).width + 8, 15);
      ctx.fillStyle = COLORS.ink;
      ctx.fillText(pl, bx, py);
      ctx.textAlign = "left";
      const now = performance.now();
      flashes.current = flashes.current.filter((f) => now - f.at < 2_000);
      for (const f of flashes.current) {
        const a = 1 - (now - f.at) / 2_000;
        ctx.globalAlpha = a;
        ctx.fillStyle = f.color;
        ctx.font = "800 20px system-ui";
        ctx.textAlign = "center";
        ctx.fillText(f.text, bx, y(f.price) - 18 - (1 - a) * 30);
        ctx.textAlign = "left";
        ctx.globalAlpha = 1;
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [lang, t]);

  // ---- dragging a wall
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const v = viewRef.current;
    const cv = canvas.current as
      | (HTMLCanvasElement & {
          _map?: { c: number; half: number; top: number; bot: number };
        })
      | null;
    if (!v?.walls || !cv?._map) return;
    const { c, half, top, bot } = cv._map;
    const r = cv.getBoundingClientRect();
    const py = e.clientY - r.top;
    const y = (p: number) =>
      (top + bot) / 2 - ((p - c) / half) * ((bot - top) / 2);
    const dHi = Math.abs(py - y(v.walls.hi));
    const dLo = Math.abs(py - y(v.walls.lo));
    if (Math.min(dHi, dLo) > 34) return;
    drag.current = {
      which: dHi < dLo ? "hi" : "lo",
      walls: { ...v.walls },
      frozen: { c, h: half },
    };
    cv.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    const cv = canvas.current as
      (HTMLCanvasElement & { _map?: { top: number; bot: number } }) | null;
    if (!d || !cv?._map) return;
    const r = cv.getBoundingClientRect();
    const py = e.clientY - r.top;
    const { top, bot } = cv._map;
    const p = Math.round(
      d.frozen.c + (((top + bot) / 2 - py) / ((bot - top) / 2)) * d.frozen.h,
    );
    d.walls =
      d.which === "hi"
        ? { ...d.walls, hi: Math.max(p, d.walls.lo + 1) }
        : { ...d.walls, lo: Math.min(p, d.walls.hi - 1) };
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d) void sendWalls(d.walls);
  };

  if (status === "signin") {
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-6">
        <Note tone="info">{t.signIn}</Note>
        {/* Sign-in lives on the Hunt home page; it returns to /hunt, so the
            card on /cota is the way back here. */}
        <div className="mt-3">
          <LinkButton href="/" tone="primary">
            {lang === "es" ? "Iniciar sesión" : "Sign in"}
          </LinkButton>
        </div>
      </main>
    );
  }

  const v = view;
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <a href="/cota" className="text-ink-dim font-mono text-xs">
          ← {t.back}
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

      <div className="border-hull-line mt-4 overflow-hidden rounded-2xl border">
        <canvas
          ref={canvas}
          className="block h-[420px] w-full touch-none"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          aria-label={t.title}
        />
      </div>
      <div className="text-ink-dim mt-2 font-mono text-xs">
        {!v?.walls
          ? t.noWalls
          : v.pos > 0
            ? t.holdingLong
            : v.pos < 0
              ? t.holdingShort
              : v.armed
                ? t.armed
                : t.waiting}
      </div>
      {msg ? (
        <div className="mt-2">
          <Note tone="warn">{msg}</Note>
        </div>
      ) : null}

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {!v?.walls ? (
          <Button
            disabled={busy || !v}
            onClick={() => v && void sendWalls(centred(v.price, 400))}
          >
            {t.place}
          </Button>
        ) : (
          <>
            <Button disabled={busy} onClick={() => void resize(0.75)}>
              {t.squeeze}
            </Button>
            <Button disabled={busy} onClick={() => void resize(1.33)}>
              {t.widen}
            </Button>
            <Button
              tone="ghost"
              disabled={busy || v.pos !== 0}
              onClick={() => void act({ action: "down" })}
            >
              {t.down}
            </Button>
          </>
        )}
        {v?.canRefill ? (
          <Button
            tone="ghost"
            disabled={busy}
            onClick={() => void act({ action: "refill" })}
          >
            {t.refill}
          </Button>
        ) : null}
      </div>

      <div className="mt-3">
        <div className="text-ink-dim mb-1 font-mono text-[11px] tracking-[0.18em] uppercase">
          {t.size}
        </div>
        <div className="flex gap-2">
          {(v?.sizes ?? [500, 1000, 5000]).map((q) => (
            <button
              key={q}
              type="button"
              disabled={busy || !v}
              onClick={() =>
                v &&
                (v.walls
                  ? void sendWalls(v.walls, q)
                  : setView({ ...v, qty: q }))
              }
              className={`rounded-xl border px-3 py-2 font-mono text-sm ${(v?.next ?? v?.qty) === q ? "border-phosphor text-phosphor" : "border-hull-line text-ink-dim"}`}
            >
              {q.toLocaleString(lang === "es" ? "es-MX" : "en-US")} MON
            </button>
          ))}
        </div>
        {v && v.pos !== 0 ? (
          <p className="text-ink-faint mt-1 font-mono text-[11px]">
            {t.sizeLocked(
              v.qty.toLocaleString(lang === "es" ? "es-MX" : "en-US"),
              v.next
                ? v.next.toLocaleString(lang === "es" ? "es-MX" : "en-US")
                : null,
            )}
          </p>
        ) : null}
      </div>

      {v ? (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Stat label={t.chips} value={chips(v.balance, lang)} />
          <Stat
            label={t.open}
            value={v.pos ? chips(v.openPnl, lang, true) : "—"}
            tone={v.openPnl < 0 ? "warn" : "credit"}
          />
          <Stat label={t.crossings} value={String(v.crossings)} tone="credit" />
          <Stat label={t.escapes} value={String(v.escapes)} tone="warn" />
          <Stat
            label={t.streak}
            value={v.streak > 1 ? `×${v.streak}` : "—"}
            sub={`max ×${v.bestStreak}`}
          />
          <Stat label={t.fees} value={chips(v.fees, lang)} />
        </div>
      ) : null}

      <div className="mt-4">
        <a href="/cota/cotas/tabla" className="text-phosphor font-mono text-sm">
          {t.board}
        </a>
      </div>

      <Panel className="mt-4">
        <h2 className="text-ink mb-2 text-lg font-semibold">{t.log}</h2>
        {!v || v.recent.length === 0 ? (
          <p className="text-ink-faint text-sm">{t.none}</p>
        ) : (
          <ol className="grid gap-2 text-sm">
            {v.recent.map((e) => (
              <li key={e.id} className="border-hull-line border-b pb-2">
                {e.kind === "grant"
                  ? t.ev.grant(chips(e.pnl ?? 0, lang))
                  : e.kind === "refill"
                    ? t.ev.refill(chips(e.pnl ?? 0, lang))
                    : e.kind === "open"
                      ? t.ev.open(e.side ?? 1, usd(e.price ?? 0), e.qty ?? 0)
                      : e.kind === "cross"
                        ? t.ev.cross(chips(e.pnl ?? 0, lang, true))
                        : t.ev.escape(chips(e.pnl ?? 0, lang, true))}
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </main>
  );
}
