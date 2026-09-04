import { OPAQUE_CLIENT_REASON } from "./types";
import type {
  ClaimMessage,
  ClaimResponse,
  ClaimSigner,
  GeoFix,
  HintBand,
  HintResponse,
  PlayerProgress,
  PublicHunt,
  PublicSpawn,
  SessionPlayerView,
  SpawnCollectResponse,
  SpawnScanResponse,
} from "./types";

/* ---------------------------------------------------------------------------
   The only place in the UI that talks to the API.

   Routes that exist and are consumed against their real handlers:

     POST   /api/hunt/[huntId]/hint           -> { complete, cacheless, band, remaining }
     POST   /api/hunt/[huntId]/claim          -> { found, ... }   unsigned today
     POST   /api/hunt/[huntId]/spawn          -> { spawned, reason, spawns }
     POST   /api/hunt/[huntId]/spawn/collect  -> { collected, ... }  SIGNED
     GET    /api/auth/session                 -> { authenticated, player }
     DELETE /api/auth/session                 -> logout

   Routes this lane needs that nobody has built. Each is declared against the
   shape the UI needs and every caller renders a "not built" state on a 404 —
   never a fabricated value:

     GET /api/hunts             hunt list      (unowned)
     GET /api/hunt/[huntId]     player-safe hunt metadata (unowned)
     GET /api/me                credit + MON + counts (auth lane)

   RATE LIMITS this file must respect (lib/ratelimit.ts):
     claim 5/min, hint 12/min, spawn 6/min per player — and `spawn` is SHARED
     between scanning and collecting, so the scan poll leaves headroom.

   Nothing in this file may ever ask for, or accept, a cache coordinate.
--------------------------------------------------------------------------- */

export class ApiError extends Error {
  readonly status: number;
  /** True when the route simply is not built yet, so the UI can say so. */
  readonly notImplemented: boolean;

  constructor(message: string, status: number, notImplemented = false) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.notImplemented = notImplemented;
  }
}

/** Thrown when a money path needs a signature and no signer is registered. */
export class SignerMissingError extends Error {
  constructor() {
    super("This action must be signed, and no signer is registered.");
    this.name = "SignerMissingError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError("malformed response", res.status);
  }
}

async function request(
  path: string,
  init?: RequestInit,
  opts?: { optional?: boolean },
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      // The session is an HttpOnly cookie; a cross-origin fetch must never
      // carry it.
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError("network unreachable", 0);
  }

  const body = await readJson(res);

  if (!res.ok) {
    const message =
      (isRecord(body) ? str(body.error) : null) ??
      `request failed (${res.status})`;
    throw new ApiError(
      message,
      res.status,
      opts?.optional === true && res.status === 404,
    );
  }
  return body;
}

/* --- Session -------------------------------------------------------------- */

/** Null when the caller is not signed in. Never throws on a 401. */
export async function fetchSession(
  signal?: AbortSignal,
): Promise<SessionPlayerView | null> {
  let body: unknown;
  try {
    body = await request("/api/auth/session", { signal });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
  if (!isRecord(body) || body.authenticated !== true) return null;
  const p = isRecord(body.player) ? body.player : {};
  const id = str(p.id);
  const walletAddress = str(p.walletAddress);
  if (id === null || walletAddress === null) return null;
  return {
    id,
    walletAddress,
    active: p.active === true,
    suspended: p.suspended === true,
  };
}

export async function endSession(): Promise<void> {
  await request("/api/auth/session", { method: "DELETE" });
}

/* --- Hint ----------------------------------------------------------------- */

const BANDS = new Set<string>(["burning", "hot", "warm", "cool", "cold"]);

function asBand(v: unknown): HintBand | null {
  const s = str(v);
  return s !== null && BANDS.has(s) ? (s as HintBand) : null;
}

/**
 * Ask how warm the player is. 12/min server-side; callers must throttle rather
 * than poll freely, or the scope goes dark on a 429 — and volume is exactly
 * what defeats the band quantization the endpoint relies on.
 */
export async function fetchHint(
  huntId: string,
  fix: Pick<GeoFix, "lat" | "lng">,
  signal?: AbortSignal,
): Promise<HintResponse> {
  const body = await request(`/api/hunt/${encodeURIComponent(huntId)}/hint`, {
    method: "POST",
    body: JSON.stringify({ lat: fix.lat, lng: fix.lng }),
    signal,
  });

  if (!isRecord(body)) throw new ApiError("malformed hint", 502);
  return {
    complete: body.complete === true,
    cacheless: body.cacheless === true,
    band: asBand(body.band),
    remaining: num(body.remaining) ?? 0,
  };
}

/* --- Signing -------------------------------------------------------------- */

/**
 * 128 bits from the CSPRNG.
 *
 * Generated client-side rather than fetched from `GET /api/auth/nonce`, which
 * the route itself says is optional ("a client is equally free to generate its
 * own random nonce") — one fewer round trip on a money path. Never
 * Math.random: the nonce is what makes a signed intent single-use, so a
 * predictable one is a replayable claim.
 */
function newNonce(): string {
  const webCrypto: Crypto | undefined =
    typeof globalThis.crypto !== "undefined" ? globalThis.crypto : undefined;
  if (webCrypto === undefined) {
    throw new ApiError("no secure random source available", 0);
  }
  if (typeof webCrypto.randomUUID === "function") {
    return webCrypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  webCrypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build the EIP-712 message from ONE instant, using the DEVICE clock.
 *
 * Deliberately not the server's clock: the verifier compares `clientTs` against
 * its own time precisely to catch a device whose clock is being steered to
 * defeat the speed check. Substituting server time here would quietly disable
 * that control from the client side.
 */
export function buildClaimMessage(
  huntId: string,
  fix: GeoFix,
  now = Date.now(),
): { message: ClaimMessage; isoTs: string } {
  const seconds = Math.floor(now / 1000);
  return {
    message: {
      huntId,
      lat: String(fix.lat),
      lng: String(fix.lng),
      accuracyM: String(fix.accuracyM),
      clientTs: seconds,
      nonce: newNonce(),
    },
    isoTs: new Date(seconds * 1000).toISOString(),
  };
}

/* --- Claim ---------------------------------------------------------------- */

/**
 * Attempt a cache claim.
 *
 * The route accepts an unsigned body today. When a signer is registered (auth
 * lane, via ClaimSignerProvider) the request additionally carries the EIP-712
 * signature and the exact message it covers, so the route can start requiring
 * one without a call site changing. It never fabricates a signature and never
 * silently swallows a signer that threw.
 */
export async function submitClaim(
  huntId: string,
  fix: GeoFix,
  signer: ClaimSigner | null,
  signal?: AbortSignal,
): Promise<ClaimResponse> {
  const { message, isoTs } = buildClaimMessage(huntId, fix);
  const signature = signer ? await signer(message) : null;

  let body: unknown;
  try {
    body = await request(`/api/hunt/${encodeURIComponent(huntId)}/claim`, {
      method: "POST",
      body: JSON.stringify({
        lat: fix.lat,
        lng: fix.lng,
        accuracyM: fix.accuracyM,
        clientTs: isoTs,
        ...(signature ? { signature, nonce: message.nonce, message } : {}),
      }),
      signal,
    });
  } catch (e) {
    if (e instanceof ApiError && e.status === 429) {
      return { found: false, reason: "rate_limited" };
    }
    throw e;
  }

  if (!isRecord(body)) throw new ApiError("malformed claim response", 502);

  if (body.found !== true) {
    // The server gives exactly one reason for every refusal, by design.
    return {
      found: false,
      reason:
        str(body.reason) === OPAQUE_CLIENT_REASON
          ? OPAQUE_CLIENT_REASON
          : "unknown",
    };
  }

  const cache = isRecord(body.cache) ? body.cache : {};

  return {
    found: true,
    findId: str(body.findId) ?? "",
    cache: {
      label: str(cache.label),
      blurb: str(cache.blurb),
      photoCid: str(cache.photoCid),
    },
    rewardCreditWei: str(body.rewardCreditWei) ?? "0",
    creditBalanceWei: str(body.creditBalanceWei),
    remaining: num(body.remaining) ?? 0,
  };
}

/* --- Spawns --------------------------------------------------------------- */

function asSpawn(v: unknown): PublicSpawn | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  const lat = num(v.lat);
  const lng = num(v.lng);
  const expiresAt = str(v.expiresAt);
  // Reject by default: a spawn missing any of these cannot be plotted, and a
  // blip at a guessed coordinate would be a lie about where money is.
  if (id === null || lat === null || lng === null || expiresAt === null) {
    return null;
  }
  return {
    id,
    lat,
    lng,
    radiusMeters: num(v.radiusMeters) ?? 25,
    amountMonWei: str(v.amountMonWei) ?? "0",
    expiresAt,
    seedCommit: str(v.seedCommit) ?? "",
  };
}

/**
 * Scan for spawns.
 *
 * This is a POST that both asks for a new spawn and returns the live ones —
 * there is no read-only spawn list. Every call spends one of six per-minute
 * `spawn` tokens, shared with collect, so callers must poll slowly.
 */
export async function scanSpawns(
  huntId: string,
  signal?: AbortSignal,
): Promise<SpawnScanResponse> {
  const body = await request(`/api/hunt/${encodeURIComponent(huntId)}/spawn`, {
    method: "POST",
    signal,
  });
  const raw = isRecord(body) && Array.isArray(body.spawns) ? body.spawns : [];
  return {
    spawned: isRecord(body) && body.spawned === true,
    reason: isRecord(body) ? str(body.reason) : null,
    spawns: raw.map(asSpawn).filter((s): s is PublicSpawn => s !== null),
  };
}

/**
 * Collect a spawn. This is the only player-reachable path that ends in native
 * MON leaving the treasury, and the route REQUIRES a valid EIP-712 signature —
 * so without a registered signer this fails loudly rather than posting
 * something that will 400.
 */
export async function collectSpawn(
  huntId: string,
  spawnId: string,
  fix: GeoFix,
  signer: ClaimSigner | null,
  signal?: AbortSignal,
): Promise<SpawnCollectResponse> {
  if (signer === null) throw new SignerMissingError();

  const { message } = buildClaimMessage(huntId, fix);
  const signature = await signer(message);

  const body = await request(
    `/api/hunt/${encodeURIComponent(huntId)}/spawn/collect`,
    {
      method: "POST",
      body: JSON.stringify({
        spawnId,
        // Strings, because these are the exact bytes that were signed.
        lat: message.lat,
        lng: message.lng,
        accuracyM: message.accuracyM,
        clientTs: message.clientTs,
        nonce: message.nonce,
        signature,
      }),
      signal,
    },
  );

  if (!isRecord(body)) throw new ApiError("malformed collect response", 502);

  if (body.collected !== true) {
    return { collected: false, reason: str(body.reason) ?? "refused" };
  }

  const payout = isRecord(body.payout) ? body.payout : {};
  return {
    collected: true,
    spawnId: str(body.spawnId) ?? spawnId,
    amountMonWei: str(body.amountMonWei) ?? "0",
    seedReveal: str(body.seedReveal) ?? "",
    payout: {
      id: str(payout.id) ?? "",
      status: str(payout.status) ?? "PENDING",
      autoApproved: payout.autoApproved === true,
      holdReason: str(payout.holdReason),
    },
  };
}

/* --- Not built yet -------------------------------------------------------- */

function asHunt(v: unknown): PublicHunt | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  const name = str(v.name);
  if (id === null || name === null) return null;
  return {
    id,
    name,
    description: str(v.description),
    active: v.active === true,
    startsAt: str(v.startsAt),
    endsAt: str(v.endsAt),
    maxAccuracyM: num(v.maxAccuracyM) ?? 30,
    cooldownSeconds: num(v.cooldownSeconds) ?? 60,
    spawnEnabled: v.spawnEnabled === true,
    spawnMaxRadiusM: num(v.spawnMaxRadiusM) ?? 600,
    remaining: num(v.remaining) ?? undefined,
  };
}

/** DEPENDS ON: `GET /api/hunts` (unowned). */
export async function fetchHunts(signal?: AbortSignal): Promise<PublicHunt[]> {
  const body = await request("/api/hunts", { signal }, { optional: true });
  const raw = isRecord(body) && Array.isArray(body.hunts) ? body.hunts : [];
  return raw.map(asHunt).filter((h): h is PublicHunt => h !== null);
}

/** DEPENDS ON: `GET /api/hunt/[huntId]` (unowned). Must not return caches. */
export async function fetchHunt(
  huntId: string,
  signal?: AbortSignal,
): Promise<PublicHunt> {
  const body = await request(
    `/api/hunt/${encodeURIComponent(huntId)}`,
    { signal },
    { optional: true },
  );
  const hunt = asHunt(isRecord(body) && isRecord(body.hunt) ? body.hunt : body);
  if (!hunt) throw new ApiError("malformed hunt", 502);
  return hunt;
}

/** DEPENDS ON: `GET /api/me` (auth lane). Wei values must stay strings. */
export async function fetchProgress(
  signal?: AbortSignal,
): Promise<PlayerProgress> {
  const body = await request("/api/me", { signal }, { optional: true });
  const v = isRecord(body) ? body : {};
  const rawPayouts = Array.isArray(v.payouts) ? v.payouts : [];
  return {
    payouts: rawPayouts.flatMap((p) => {
      if (!isRecord(p)) return [];
      const id = str(p.id);
      const amountMonWei = str(p.amountMonWei);
      const at = str(p.at);
      if (id === null || amountMonWei === null || at === null) return [];
      return [{
        id,
        status: str(p.status) ?? "UNKNOWN",
        amountMonWei,
        txHash: str(p.txHash),
        at,
      }];
    }),
    walletAddress: str(v.walletAddress),
    // Deliberately NOT defaulted to "0" — see PlayerProgress.
    walletBalanceWei: str(v.walletBalanceWei),
    creditBalanceWei: str(v.creditBalanceWei) ?? "0",
    collectedMonWei: str(v.collectedMonWei) ?? "0",
    pendingMonWei: str(v.pendingMonWei) ?? "0",
    findCount: num(v.findCount) ?? 0,
    spawnCount: num(v.spawnCount) ?? 0,
    turboUsername: str(v.turboUsername),
  };
}

/**
 * Establish a verified position without finding anything.
 *
 * Spawns anchor to `PlayerHunt.lastVerified*`, which used to be written only by
 * a cache find or a spawn collect. That made the first one impossible anywhere
 * nobody had planted a cache: the player walks, the scan returns
 * `no_verified_position` forever, and nothing ever appears. This is the
 * bootstrap — it pays nothing and exists purely so the scan has an anchor.
 *
 * A refusal is returned rather than thrown. "Your GPS is not accurate enough
 * yet" is an ordinary state for somebody standing outdoors, not an exception.
 */
export async function checkIn(
  huntId: string,
  fix: GeoFix,
  signal?: AbortSignal,
): Promise<{ ok: boolean; reason: string | null }> {
  try {
    const body = await request(
      `/api/hunt/${encodeURIComponent(huntId)}/checkin`,
      {
        method: "POST",
        body: JSON.stringify({
          lat: fix.lat,
          lng: fix.lng,
          accuracyM: fix.accuracyM,
          clientTs: Date.now(),
        }),
        signal,
      },
    );
    return {
      ok: isRecord(body) && body.ok === true,
      reason: isRecord(body) ? str(body.reason) : null,
    };
  } catch (e) {
    // Being rate-limited is not worth surfacing: the next scan tick retries,
    // and the player has done nothing wrong.
    if (e instanceof ApiError && e.status === 429) {
      return { ok: false, reason: null };
    }
    throw e;
  }
}
