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
  forwardingAllowed: boolean;
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
      forwardingAllowed: a.fw === true,
      feeTier: Number(a.ft ?? 0),
      available: balance - locked,
    };
  });
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
