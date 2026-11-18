// ---------------------------------------------------------------------------
// Where the Chip Board game server lives. Server-only helpers.
//
//   NEXT_PUBLIC_CHIPBOARD_WS_URL  the browser's WebSocket URL, e.g.
//                                 wss://chips.empowertours.xyz/ws
//   CHIPBOARD_HTTP_URL            optional: the server's HTTP base as seen from
//                                 this app (e.g. a private network address).
//                                 Defaults to the WS URL's origin.
// ---------------------------------------------------------------------------

type Env = Record<string, string | undefined>;

/** The WebSocket URL, or null when unset or not ws(s)://. */
export function wsUrl(env: Env = process.env): string | null {
  const raw = env.NEXT_PUBLIC_CHIPBOARD_WS_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "ws:" || u.protocol === "wss:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The HTTP base for /leaderboard, without a trailing slash, or null. */
export function httpBase(env: Env = process.env): string | null {
  const explicit = env.CHIPBOARD_HTTP_URL?.trim();
  if (explicit) {
    try {
      const u = new URL(explicit);
      if (u.protocol === "http:" || u.protocol === "https:")
        return u.origin + u.pathname.replace(/\/+$/, "");
    } catch {
      /* fall through to the WS URL */
    }
    return null;
  }
  const ws = wsUrl(env);
  if (!ws) return null;
  const u = new URL(ws);
  return `${u.protocol === "wss:" ? "https:" : "http:"}//${u.host}`;
}
