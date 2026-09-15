// Perpl trading-socket frame codecs — the pure, testable protocol layer of the
// executor. Ported from Mandate's proven client (src/venue_client.py) and its
// reference mock (src/venue_mock.py, whose frame shapes are documented as
// corrected against REAL venue frames after a live fill raised KeyError on an
// invented shape). No socket, no keys — just build/parse, so the risky WS
// transport rides on a layer held byte-exact to captured frames by frames.test.
//
// Message types (src/venue.py):
//   3  STATUS         19 WALLET_SNAPSHOT   21 ACCOUNT_UPDATE
//   22 ORDER_REQUEST  24 ORDER_UPDATE      25 FILLS_UPDATE   29 API_KEY_SIGNIN

export const SIGNIN_CONTEXT = "trading-ws-signin";
export const CODE_ACCEPTED = 0;

/**
 * The exact bytes the Ed25519 sign-in signs (src/venue_client.py::_signin_frame):
 * chain_id, context, timestamp, nonce — newline-joined. A client that signs a
 * different concatenation authenticates as nobody.
 */
export function signinCanonicalBytes(
  chainId: number,
  timestampMs: number,
  nonce: string,
): Uint8Array {
  const canonical = [
    String(chainId),
    SIGNIN_CONTEXT,
    String(timestampMs),
    nonce,
  ].join("\n");
  return new TextEncoder().encode(canonical);
}

export interface AccountSnapshot {
  accountId: number;
  /** Collateral base units (AUSD, 6dp scaled), as the venue sends them. */
  balance: number;
  locked: number;
  frozen: boolean;
  /**
   * `fw`: whether the venue will FORWARD an order to the chain for this account,
   * which is the only way an API key can trade it. An OMITTED `fw` reads as
   * ALLOWED, matching Mandate's parser (src/account_status.py:164). That is
   * deliberate and it is the one place this layer does not fail closed: the
   * leash's bounds protect the hunter's money, so refusing on doubt is right
   * there, but this flag only describes what the venue can do. If Perpl ever
   * stops sending `fw`, defaulting to false would refuse every hunter an order
   * the venue would happily have filled — blocking everyone to prevent nothing.
   * A truly unforwardable order is still caught: the venue rejects it and mt 24
   * names OrderForwardingNotAllowed.
   */
  forwardingAllowed: boolean;
  /**
   * `lfr`: the last request id the venue FORWARDED for this account. The next
   * order's `rq` must be strictly greater — it is the venue's idempotency key,
   * per account (mandate/src/venue_client.py:92). See nextRequestId.
   */
  lastRequestId: number;
  feeTier: number;
  /** balance - locked, the free collateral an order is checked against. */
  available: number;
}

/**
 * Parse a wallet snapshot (mt 19). The accounts ride under `as`; each carries
 * id, balance `b`, locked `lb`, fee tier `ft`, frozen `fr`, forwarding `fw`.
 * The mock omitting `as` and sending a bare balance was the exact bug the real
 * shape corrects — so this reads `as`, not a top-level balance.
 */
export function parseWalletSnapshot(frame: unknown): AccountSnapshot[] {
  const f = frame as { mt?: number; as?: unknown[] };
  if (f?.mt !== 19 || !Array.isArray(f.as)) return [];
  return f.as.map((raw) => {
    const a = raw as Record<string, unknown>;
    const balance = Number(a.b ?? 0);
    const locked = Number(a.lb ?? 0);
    return {
      accountId: Number(a.id ?? 0),
      balance,
      locked,
      frozen: a.fr === true,
      forwardingAllowed: a.fw !== false,
      lastRequestId: Number(a.lfr ?? 0),
      feeTier: Number(a.ft ?? 0),
      available: balance - locked,
    };
  });
}

export interface OpenPositionFrame {
  /** Position id. */
  pid: number;
  /** Market id. */
  marketId: number;
  /** Side: 1 long, 2 short (SD_LONG / SD_SHORT). */
  side: number;
  /** Size in the market's scaled integer units (descale by size_decimals). */
  sizeScaled: number;
  /** Leverage ×100, as the venue sends it. */
  leverageX100: number;
  /**
   * `ep`: the position's entry price in the market's scaled integer units
   * (descale by price_decimals), or null when the frame omits it.
   *
   * This field was believed not to exist. See the note on parsePositions.
   */
  entryPriceScaled: number | null;
  /** `fee`: fee charged on this position so far, AUSD 6dp. Null if omitted. */
  feeScaled: number | null;
}

/**
 * The `rq` to send on the next order for this account.
 *
 * `rq` is the venue's IDEMPOTENCY KEY and must be strictly increasing per
 * account. This client sent a literal 1 on every order, on a fresh socket every
 * time, which is why account 5273 filled exactly once and then stopped: the
 * first order met `lfr:0`, was forwarded, and advanced `lfr` to 1 — and every
 * order after it re-sent `rq:1`, which is no longer greater than what the venue
 * has already executed. The gateway still acks with code 0 and the chain does
 * nothing, so it presents as "accepted, not filled" forever. Exactly the same
 * symptom as fw:false, and exactly as silent.
 *
 * Both terms matter. `lastRequestId + 1` is what makes it greater than what this
 * account has actually executed. The clock is what Mandate seeds from
 * (venue_client.py:95) so a reconnect can never reuse a value the venue already
 * ran; taking the max keeps that property without depending on the frame being
 * fresh.
 *
 * Known limit: two orders placed within the same account before the first has
 * been forwarded will read the same `lfr` and, if issued in the same
 * millisecond, the same `rq`. Hunters place one at a time and the clock breaks
 * the tie in practice; a queue would be the real answer if that stops being true.
 */
export function nextRequestId(account: AccountSnapshot, nowMs: number): number {
  return Math.max(account.lastRequestId + 1, nowMs);
}

/**
 * Parse a positions frame (mt 26 snapshot / mt 27 update): `{d:[{pid,mkt,sd,st,
 * lv,s}]}`. Returns ONLY status-open positions (`st === PS_OPEN`); a closed,
 * liquidated or deleveraged position is dropped, because open notional is a sum
 * over what is still open. Ported from src/venue_client.py's positions handler.
 *
 * CORRECTION (2026-09-14, read off a live frame from account 5273 — the first
 * position this executor ever opened). This comment used to say the frame
 * carries no entry price or PnL, citing Mandate's KNOWN_POSITION_KEYS
 * (src/account_status.py:111). That set is only the six keys MANDATE PARSED, not
 * a survey of what the venue sends, and the `unrecognised_fields` probe built to
 * find out was never run against an open position. The real frame is:
 *
 *   {pid, mkt, acc, st, sr, sd, s, lv, ep, c, fee, cfee, cpnl, dpnl, fnd, pay,
 *    efs, xfs, oid, rq, ots, at}
 *
 * `ep` IS the entry price. It checks out against the venue's own totals to the
 * microdollar: s=214 × ep=23308 = 4_987_912 = the `tv` (traded volume) on the
 * same account's stats frame, and c=2_504_014 + fee=4_440 is exactly the balance
 * the account lost opening it. So `size × (mark − ep)` — the unrealised PnL the
 * daily-loss stop was built around NOT having — is computable straight from
 * here.
 *
 * Nothing downstream is switched over to it yet: the fills-VWAP ledger is the
 * proven path and still carries realised PnL, which this frame does not give per
 * day. What `ep` is used for today is reconciliation — adopting a position the
 * ledger missed at the venue's OWN entry price rather than a guessed one.
 */
/** A frame field that may be absent, a number, or a numeric string. */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parsePositions(frame: unknown): OpenPositionFrame[] {
  const f = frame as { mt?: number; d?: unknown[] };
  if ((f?.mt !== 26 && f?.mt !== 27) || !Array.isArray(f.d)) return [];
  const out: OpenPositionFrame[] = [];
  for (const raw of f.d) {
    const pos = raw as Record<string, unknown>;
    if (Number(pos.st) !== 1) continue; // PS_OPEN only
    const pid = pos.pid;
    const mkt = pos.mkt;
    if (typeof pid !== "number" || typeof mkt !== "number") continue;
    out.push({
      pid,
      marketId: mkt,
      side: Number(pos.sd ?? 0),
      sizeScaled: Number(pos.s ?? 0),
      leverageX100: Number(pos.lv ?? 0),
      entryPriceScaled: numOrNull(pos.ep),
      feeScaled: numOrNull(pos.fee),
    });
  }
  return out;
}

export interface OrderStatus {
  /** Echoes the order's `sn`, so a client matches a status to its request. */
  clientSeq: number;
  code: number;
  error: string;
  accepted: boolean;
}

/** Parse an order status ack (mt 3): `{cid, status:{code,error}}`. */
export function parseOrderStatus(frame: unknown): OrderStatus | null {
  const f = frame as {
    mt?: number;
    cid?: number;
    status?: { code?: number; error?: string };
  };
  if (f?.mt !== 3) return null;
  const code = Number(f.status?.code ?? -1);
  return {
    clientSeq: Number(f.cid ?? 0),
    code,
    error: String(f.status?.error ?? ""),
    accepted: code === CODE_ACCEPTED,
  };
}

export interface Fill {
  /** The `rq` the order went out under — how a fill is tied back to its order. */
  orderRq: number;
  sizeScaled: number;
  priceScaled: number;
  /** Total (protocol+builder) fee, decimal STRING in collateral base units. */
  feeBaseUnits: string;
  /** Builder-only fee, decimal string in collateral base units. */
  builderFeeBaseUnits: string;
}

/**
 * Parse a fill (mt 25). `f`/`bfa` are decimal STRINGS in collateral base units,
 * not float dollars — reading them as floats once turned an "880" base-unit fee
 * into a claimed $880 fee on a $0.99 trade (see venue_mock's comment). Kept as
 * strings here; the caller scales with the collateral decimals.
 */
export function parseFill(frame: unknown): Fill | null {
  const f = frame as Record<string, unknown>;
  if (f?.oid === undefined && f?.mt !== 25) return null;
  const rq = f.oid ?? (f as { rq?: unknown }).rq;
  if (rq === undefined) return null;
  return {
    orderRq: Number(rq),
    sizeScaled: Number(f.s ?? 0),
    priceScaled: Number(f.p ?? 0),
    feeBaseUnits: String(f.f ?? "0"),
    builderFeeBaseUnits: String(f.bfa ?? "0"),
  };
}
