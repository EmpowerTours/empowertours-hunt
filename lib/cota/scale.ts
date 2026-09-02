// ---------------------------------------------------------------------------
// Scaling for a Cota's ceilings.
//
// A Cota is an UPPER BOUND, and every field in it is a number the player will
// later be measured against. That makes the scaling rules different from the
// ones in lib/auth/typedData.ts, where lat/lng are signed as strings so the
// signed bytes are exactly the characters the client sent.
//
// A coordinate only has to round-trip. A ceiling has to be COMPARED — "was
// this fill inside the limit?" is arithmetic, not string equality — so the
// ceilings are signed as scaled integers instead. USD carries at 1e6 and
// leverage at 1e2, matching the venue's own units.
//
// The rule that matters: a value that does not survive the round trip exactly
// is REJECTED, never rounded. Rounding a ceiling up hands the player a limit
// they did not agree to; rounding it down enforces one they did not either.
// Either way the number in the signature stops being the number they read, and
// a bound nobody agreed to is worse than no bound at all.
// ---------------------------------------------------------------------------

/** USDC-style. $12.34 -> 12_340_000n. */
export const USD_SCALE = 1_000_000n;

/** Hundredths. 3.0x -> 300n. */
export const LEVERAGE_SCALE = 100n;

/**
 * A value could not be represented exactly at the agreed scale.
 *
 * RangeError rather than a bare Error to match `WeiError` in lib/wei.ts — a
 * caller catching numeric-domain failures should not have to know which
 * module raised.
 */
export class LossyScaleError extends RangeError {
  constructor(field: string, value: number, scale: bigint) {
    const grid = 1 / Number(scale);
    super(
      `${field}=${value} is not representable at scale ${scale} ` +
        `(choose a value on the ${grid} grid)`,
    );
    this.name = "LossyScaleError";
  }
}

function scaleExact(value: number, scale: bigint, field: string): bigint {
  if (!Number.isFinite(value)) throw new LossyScaleError(field, value, scale);
  if (value < 0) throw new LossyScaleError(field, value, scale);

  const scaled = value * Number(scale);
  const nearest = Math.round(scaled);

  // The tolerance is for binary floating point, not for the caller's slop:
  // 12.34 * 1e6 is 12339999.999999998 in IEEE-754, which must be accepted,
  // while 0.0000005 * 1e6 = 0.5 must not. A tolerance of 1e-6 separates a
  // representation artefact from a value that genuinely sits between grid
  // points.
  if (Math.abs(scaled - nearest) > 1e-6) {
    throw new LossyScaleError(field, value, scale);
  }
  return BigInt(nearest);
}

/** Dollars to 1e6 units. Throws rather than rounds. */
export function usdE6(value: number, field = "usd"): bigint {
  return scaleExact(value, USD_SCALE, field);
}

/** Multiplier to hundredths. Throws rather than rounds. */
export function leverageX100(value: number, field = "leverage"): bigint {
  return scaleExact(value, LEVERAGE_SCALE, field);
}

/** Back to a human string, for rendering what was signed. */
export function fromUsdE6(v: bigint): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / USD_SCALE;
  const frac = (abs % USD_SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

/** Back to a human string. 325n -> "3.25". */
export function fromLeverageX100(v: bigint): string {
  const whole = v / LEVERAGE_SCALE;
  const frac = (v % LEVERAGE_SCALE)
    .toString()
    .padStart(2, "0")
    .replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""}`;
}
