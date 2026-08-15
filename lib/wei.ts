// Wei conversion — the single place a value crosses between the database's
// `Decimal(78, 0)`, the code's `bigint`, and a human's keyboard.
//
// Everything here exists because `BigInt()` is a trap on this boundary. It is
// happy to accept inputs that mean something entirely different from what the
// caller intended, and it throws on inputs that look obviously fine:
//
//   BigInt("1e18")      -> SyntaxError            (a person means 1 MON)
//   BigInt("0x10")      -> 16n                    (a person means sixteen, in a
//                                                  field where everything else
//                                                  is decimal — silently 16 wei)
//   BigInt("")          -> 0n                     (an empty admin form pays 0)
//   BigInt(" 5 ")       -> 5n                     (whitespace silently accepted,
//                                                  so a paste with a stray space
//                                                  looks the same as a typo)
//   BigInt(0.5)         -> RangeError             (thrown from wherever it lands)
//   Number("0.001")*1e18 -> 1000000000000000.1    (float, wrong by design)
//
// And on the database side, `Prisma.Decimal` is decimal.js: for values at or
// above 1e21 — i.e. anything over 1000 MON — `.toString()` returns "1e+21",
// which `BigInt()` then refuses. Verified against @prisma/client 6.19.3 in this
// repo. `.toFixed()` is the accessor that always yields plain notation, so it
// is the one used here.
//
// Rule for this file: parse strictly, reject anything ambiguous, and never
// round a value that represents money.

import type { Prisma } from "@prisma/client";

/** Unsigned integer, no sign, no separators, no exponent, no radix prefix. */
const UNSIGNED_INTEGER = /^(0|[1-9][0-9]*)$/;

/** Optional minus, then an unsigned integer. Used only where a signed ledger
 *  entry is legitimate (CreditLedger corrections are negative rows). */
const SIGNED_INTEGER = /^-?(0|[1-9][0-9]*)$/;

/** `Decimal(78, 0)` — 78 significant digits, scale 0. */
const MAX_DIGITS = 78;

/** Native MON, like ether, has 18 decimals. */
export const WEI_DECIMALS = 18;
const WEI_PER_MON = 10n ** BigInt(WEI_DECIMALS);

export class WeiError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "WeiError";
  }
}

/**
 * Render a Prisma Decimal without exponent notation.
 *
 * Duck-typed rather than `instanceof Prisma.Decimal` so this module does not
 * need a runtime import of the generated client — that keeps the pure tests
 * free of a database dependency.
 */
function decimalToPlainString(d: object): string {
  const candidate = d as { toFixed?: unknown; toString(): string };
  if (typeof candidate.toFixed === "function") {
    // decimal.js `toFixed()` with no argument: full precision, normal notation.
    // `toFixed(0)` would ROUND, which on a money value is a silent theft or a
    // silent gift. Never pass an argument here.
    return (candidate.toFixed as () => string).call(candidate);
  }
  return candidate.toString();
}

/**
 * Prisma Decimal -> bigint. Throws on a non-integer or negative value.
 */
export function toWei(d: Prisma.Decimal | string | number): bigint {
  if (typeof d === "number") {
    // A float cannot represent wei. Anything that is not a safe integer is
    // either fractional, infinite, NaN, or already past 2^53 and therefore
    // already wrong before it got here.
    if (!Number.isSafeInteger(d)) {
      throw new WeiError(
        `toWei: ${String(d)} is not a safe integer; wei must never travel through a float`,
      );
    }
    if (!(d >= 0)) {
      throw new WeiError(`toWei: ${d} is negative`);
    }
    return BigInt(d);
  }

  const raw =
    typeof d === "string"
      ? d
      : d === null || typeof d !== "object"
        ? String(d)
        : decimalToPlainString(d);

  if (!UNSIGNED_INTEGER.test(raw)) {
    // Covers "", " 5 ", "1e18", "0x10", "0.5", "-1", "abc" and "+5" in one
    // reject-by-default test rather than a list of special cases.
    throw new WeiError(
      `toWei: ${JSON.stringify(raw)} is not a non-negative integer`,
    );
  }
  if (raw.length > MAX_DIGITS) {
    throw new WeiError(
      `toWei: ${raw.length} digits exceeds the Decimal(${MAX_DIGITS}, 0) column`,
    );
  }
  return BigInt(raw);
}

/**
 * Like {@link toWei} but permits a negative value.
 *
 * Only for columns that are documented as signed — `CreditLedger.amountWei`
 * carries negative corrections. Never use this on a payout amount: a negative
 * payout is a bug, and the strict version is what catches it.
 */
export function toSignedWei(d: Prisma.Decimal | string | number): bigint {
  if (typeof d === "number") {
    if (!Number.isSafeInteger(d)) {
      throw new WeiError(`toSignedWei: ${String(d)} is not a safe integer`);
    }
    return BigInt(d);
  }
  const raw =
    typeof d === "string"
      ? d
      : d === null || typeof d !== "object"
        ? String(d)
        : decimalToPlainString(d);
  if (!SIGNED_INTEGER.test(raw)) {
    throw new WeiError(`toSignedWei: ${JSON.stringify(raw)} is not an integer`);
  }
  if (raw.replace("-", "").length > MAX_DIGITS) {
    throw new WeiError(
      `toSignedWei: ${raw.length} digits exceeds the Decimal(${MAX_DIGITS}, 0) column`,
    );
  }
  return BigInt(raw);
}

/**
 * bigint -> string safe to hand Prisma for a Decimal(78,0) column.
 *
 * Plain decimal notation always, so the value that reaches Postgres is the
 * value that left the code. Rejects anything wider than the column rather than
 * letting Postgres raise a numeric overflow at write time, halfway through a
 * transaction that has already done something.
 */
export function fromWei(v: bigint): string {
  if (typeof v !== "bigint") {
    throw new WeiError(`fromWei: expected bigint, got ${typeof v}`);
  }
  const digits = (v < 0n ? -v : v).toString().length;
  if (digits > MAX_DIGITS) {
    throw new WeiError(
      `fromWei: ${digits} digits exceeds the Decimal(${MAX_DIGITS}, 0) column`,
    );
  }
  return v.toString();
}

/**
 * Human display, e.g. 1000000000000000n -> "0.001".
 *
 * Truncates rather than rounds. Rounding a displayed payout up would show a
 * player a number the treasury never sent.
 */
export function formatMon(
  v: bigint,
  maxDecimals: number = WEI_DECIMALS,
): string {
  if (typeof v !== "bigint") {
    throw new WeiError(`formatMon: expected bigint, got ${typeof v}`);
  }
  if (
    !Number.isInteger(maxDecimals) ||
    maxDecimals < 0 ||
    maxDecimals > WEI_DECIMALS
  ) {
    throw new WeiError(
      `formatMon: maxDecimals must be an integer 0..${WEI_DECIMALS}`,
    );
  }

  const negative = v < 0n;
  const magnitude = negative ? -v : v;
  const whole = magnitude / WEI_PER_MON;
  const fraction = magnitude % WEI_PER_MON;

  let frac = fraction
    .toString()
    .padStart(WEI_DECIMALS, "0")
    .slice(0, maxDecimals);
  frac = frac.replace(/0+$/, "");

  const body = frac.length > 0 ? `${whole}.${frac}` : whole.toString();
  return negative && (whole > 0n || frac.length > 0) ? `-${body}` : body;
}

/**
 * Parse admin input. Rejects "1e18", "0x10", "", " 5 ", negatives, decimals
 * beyond 18dp.
 *
 * The input is a MON amount as a person would type it ("0.001"), and the
 * result is wei. Deliberately does NOT trim: a value arriving with whitespace
 * came from a paste or a broken form, and quietly accepting it means the one
 * case where the whitespace hid something else also gets accepted.
 */
export function parseMonInput(input: string): bigint {
  if (typeof input !== "string") {
    throw new WeiError(`parseMonInput: expected string, got ${typeof input}`);
  }
  // Reject-by-default: one anchored pattern, everything outside it refused.
  // No sign, no exponent, no radix prefix, no separators, no bare "." on
  // either side, at most 18 decimal places.
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,18}))?$/.exec(input);
  if (!match) {
    throw new WeiError(
      `parseMonInput: ${JSON.stringify(input)} is not a plain decimal MON amount (max ${WEI_DECIMALS} dp, no sign, no exponent, no whitespace)`,
    );
  }

  const whole = BigInt(match[1]);
  const fracDigits = match[2] ?? "";
  const frac = fracDigits.length
    ? BigInt(fracDigits.padEnd(WEI_DECIMALS, "0"))
    : 0n;

  const wei = whole * WEI_PER_MON + frac;
  if (wei.toString().length > MAX_DIGITS) {
    throw new WeiError(
      `parseMonInput: ${input} MON exceeds the Decimal(${MAX_DIGITS}, 0) column`,
    );
  }
  return wei;
}
