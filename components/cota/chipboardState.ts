import { NB, sum } from "./chipboardMath";

// ---------------------------------------------------------------------------
// The Chip Board client state, driven only by server messages.
//
// Wire protocol: services/chipboard/internal/server/ws.go and hub.go. Server
// frames hold one or more JSON messages separated by "\n". Everything that
// decides an outcome (round times, bands, the baseline, the close, points,
// standings) comes from the server; the client keeps the chips it is still
// placing optimistically and puts them back to the server's last answer when
// a placement is refused.
// ---------------------------------------------------------------------------

export type Status = "open" | "locked" | "settled" | "void";

/** engine.Round as the server sends it. */
export interface WireRound {
  id: number;
  open: number;
  lock: number;
  close: number;
  status: Status;
  openPrice: number;
  sigma: number;
  band: number;
  centre: number;
  edges: number[];
  lockPrice?: number;
  baseline?: number[] | null;
  closePrice?: number;
  landed: number;
  voidReason?: string;
}

export interface Standing {
  day: string;
  points: number;
  rounds: number;
  rank: number;
  players: number;
  qualified: boolean;
  qualifyRounds: number;
}

export type ServerMsg =
  | {
      t: "hello";
      ts: number;
      player: string;
      rule: string;
      rounds: Array<WireRound & { chips: number[] }>;
      qualifyRounds: number;
      holdMs: number;
      openMs: number;
      day: string;
      standing?: Standing;
      trail?: Array<[number, number]>;
    }
  | { t: "px"; ts: number; p?: number }
  | { t: "open"; round: WireRound }
  | { t: "lock"; round: number; lockPrice: number; baseline: number[] }
  | {
      t: "close";
      round: number;
      rule: string;
      price: number;
      band: number;
    }
  | { t: "void"; round: number; phase: string; reason: string }
  | {
      t: "result";
      round: number;
      price: number;
      band: number;
      chips: number[];
      placed: number;
      points: number;
    }
  | ({ t: "standing" } & Standing)
  | {
      t: "ack";
      id?: number;
      ok: boolean;
      reason?: string;
      round?: number;
      chips?: number[];
      left?: number;
      ts?: number;
    }
  | { t: "pong"; id?: number; ts: number };

export interface RoundView extends WireRound {
  /** What the board shows: the server's chips plus any placement in flight. */
  chips: number[];
  /** The server's last accepted chips for this player. */
  confirmed: number[];
  /** Id of the newest placement sent for this round. */
  lastSent: number;
  voidPhase?: string;
  /** Set from this player's result message: the server's score. */
  result?: { points: number; placed: number; chips: number[]; price: number };
}

export interface HistoryEntry {
  round: number;
  /** Settled: the server's numbers. */
  points?: number;
  price?: number;
  placed?: number;
  chips?: number[];
  baseline?: number[] | null;
  landed?: number;
  /** Void: why, and at which step. */
  voidReason?: string;
  voidPhase?: string;
}

export interface Toast {
  kind: "win" | "lose" | "void";
  points?: number;
  round: number;
  price?: number;
  reason?: string;
  at: number;
}

export interface GameState {
  player: string | null;
  rule: string | null;
  qualifyRounds: number;
  holdMs: number;
  openMs: number;
  rounds: RoundView[];
  /** Reference price, oldest first: [server ms, price]. */
  px: Array<{ t: number; p: number }>;
  /** Server time minus local time, ms (best estimate: least network delay). */
  skew: number | null;
  standing: Standing | null;
  history: HistoryEntry[];
  toast: Toast | null;
  refusal: { reason: string; at: number } | null;
  /** A round that just settled, for the landing flash. */
  flash: { round: number; at: number } | null;
  /** Bumped when a round settles, so the leaderboard can be refetched. */
  closes: number;
}

export const initialState = (): GameState => ({
  player: null,
  rule: null,
  qualifyRounds: 20,
  holdMs: 60_000,
  openMs: 20_000,
  rounds: [],
  px: [],
  skew: null,
  standing: null,
  history: [],
  toast: null,
  refusal: null,
  flash: null,
  closes: 0,
});

const PX_KEEP_MS = 5 * 60_000;
const ROUND_KEEP_MS = 30_000;
const HISTORY_KEEP = 30;
const zeros = () => new Array<number>(NB).fill(0);

/** Split a frame into messages. Lines that are not JSON objects are skipped. */
export function parseFrame(data: string): ServerMsg[] {
  const out: ServerMsg[] = [];
  for (const line of data.split("\n")) {
    if (!line.trim()) continue;
    try {
      const m: unknown = JSON.parse(line);
      if (
        m &&
        typeof m === "object" &&
        typeof (m as { t?: unknown }).t === "string"
      )
        out.push(m as ServerMsg);
    } catch {
      /* a bad line must not take the frame's other messages with it */
    }
  }
  return out;
}

function noteSkew(s: GameState, serverTs: number, localNow: number) {
  // A message arrives after it was stamped, so ts - local underestimates the
  // offset by the network delay. Keep the largest seen (least delayed), but
  // let it decay slowly so a clock step on either side is followed.
  const sample = serverTs - localNow;
  s.skew =
    s.skew === null || sample > s.skew
      ? sample
      : s.skew - 0.02 * (s.skew - sample);
}

function upsertRound(s: GameState, r: WireRound, chips?: number[]) {
  const have = s.rounds.find((x) => x.id === r.id);
  const c = chips && chips.length === NB ? [...chips] : zeros();
  if (have) Object.assign(have, r);
  else
    s.rounds.push({
      ...r,
      edges: [...r.edges],
      chips: c,
      confirmed: [...c],
      lastSent: 0,
    });
  s.rounds.sort((a, b) => a.id - b.id);
}

function prune(s: GameState, serverNow: number) {
  s.rounds = s.rounds.filter(
    (r) =>
      r.status === "open" ||
      r.status === "locked" ||
      serverNow - r.close < ROUND_KEEP_MS,
  );
  const cut = serverNow - PX_KEEP_MS;
  let i = 0;
  while (i < s.px.length && s.px[i].t < cut) i++;
  if (i) s.px = s.px.slice(i);
}

/**
 * Apply one server message. Mutates and returns `s` (the component keeps it
 * in a ref and redraws every animation frame). `localNow` is Date.now().
 */
export function apply(s: GameState, m: ServerMsg, localNow: number): GameState {
  switch (m.t) {
    case "hello": {
      noteSkew(s, m.ts, localNow);
      s.player = m.player;
      s.rule = m.rule;
      s.qualifyRounds = m.qualifyRounds;
      s.holdMs = m.holdMs;
      s.openMs = m.openMs;
      // The server's view replaces ours: a reconnect may have missed events.
      const live = new Set(m.rounds.map((r) => r.id));
      s.rounds = s.rounds.filter(
        (r) => !live.has(r.id) && r.status !== "open" && r.status !== "locked",
      );
      for (const r of m.rounds) upsertRound(s, r, r.chips);
      if (m.standing) s.standing = m.standing;
      if (m.trail?.length) {
        const first = m.trail[0][0];
        s.px = [
          ...s.px.filter((x) => x.t < first),
          ...m.trail.map(([t, p]) => ({ t, p })),
        ];
      }
      break;
    }
    case "px":
      noteSkew(s, m.ts, localNow);
      if (typeof m.p === "number") {
        const last = s.px[s.px.length - 1];
        if (!last || m.ts > last.t) s.px.push({ t: m.ts, p: m.p });
      }
      prune(s, m.ts);
      break;
    case "open":
      upsertRound(s, m.round);
      break;
    case "lock": {
      const r = s.rounds.find((x) => x.id === m.round);
      if (r) {
        r.status = "locked";
        r.lockPrice = m.lockPrice;
        r.baseline = m.baseline;
        // Whatever the server last accepted is what is on the round now.
        r.chips = [...r.confirmed];
      }
      break;
    }
    case "close": {
      const r = s.rounds.find((x) => x.id === m.round);
      if (r) {
        r.status = "settled";
        r.closePrice = m.price;
        r.landed = m.band;
      }
      s.flash = { round: m.round, at: localNow };
      s.closes++;
      break;
    }
    case "void": {
      const r = s.rounds.find((x) => x.id === m.round);
      const had = r ? sum(r.confirmed) > 0 : false;
      if (r) {
        r.status = "void";
        r.voidReason = m.reason;
        r.voidPhase = m.phase;
      }
      if (had) {
        s.history.unshift({
          round: m.round,
          voidReason: m.reason,
          voidPhase: m.phase,
          placed: r ? sum(r.confirmed) : 0,
        });
        s.history = s.history.slice(0, HISTORY_KEEP);
        s.toast = {
          kind: "void",
          round: m.round,
          reason: m.reason,
          at: localNow,
        };
      }
      break;
    }
    case "result": {
      const r = s.rounds.find((x) => x.id === m.round);
      if (r)
        r.result = {
          points: m.points,
          placed: m.placed,
          chips: m.chips,
          price: m.price,
        };
      s.history.unshift({
        round: m.round,
        points: m.points,
        price: m.price,
        placed: m.placed,
        chips: m.chips,
        baseline: r?.baseline ?? null,
        landed: m.band,
      });
      s.history = s.history.slice(0, HISTORY_KEEP);
      s.toast = {
        kind: m.points >= 0 ? "win" : "lose",
        points: m.points,
        round: m.round,
        price: m.price,
        at: localNow,
      };
      break;
    }
    case "standing": {
      const { t: _t, ...st } = m;
      void _t;
      s.standing = st;
      break;
    }
    case "ack": {
      const r =
        m.round !== undefined
          ? s.rounds.find((x) => x.id === m.round)
          : undefined;
      if (m.ok && r && m.chips) {
        r.confirmed = [...m.chips];
        // Later placements are still in flight: keep showing them.
        if (m.id === r.lastSent) r.chips = [...m.chips];
      } else if (!m.ok) {
        if (r) r.chips = [...r.confirmed];
        s.refusal = { reason: m.reason ?? "bad_message", at: localNow };
      }
      break;
    }
    case "pong":
      noteSkew(s, m.ts, localNow);
      break;
  }
  return s;
}

/** The round taking chips at serverNow, if any. */
export function openRound(s: GameState, serverNow: number): RoundView | null {
  return (
    s.rounds.find((r) => r.status === "open" && serverNow < r.lock) ?? null
  );
}

export function lastPrice(s: GameState): number | null {
  return s.px.length ? s.px[s.px.length - 1].p : null;
}
