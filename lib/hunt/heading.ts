// ---------------------------------------------------------------------------
// Turning a device-orientation event into a compass heading.
//
// Pure, and separate from the hook, because every interesting case here is a
// platform quirk that would otherwise only be discoverable by standing outside
// with two different phones.
//
// ## A relative heading is worse than no heading
//
// The standard `deviceorientation` event reports `alpha` relative to whatever
// direction the device happened to be facing when it started listening, unless
// `absolute` is true. Rotating a map by a relative alpha produces a scope that
// looks authoritative and points somewhere arbitrary — which is strictly worse
// than a north-up scope the player knows to interpret. So anything that is not
// demonstrably absolute returns null and the UI says it is north-up.
// ---------------------------------------------------------------------------

/** The shape both platforms deliver, minus everything we do not read. */
export interface OrientationLike {
  absolute?: boolean;
  alpha?: number | null;
  /** iOS only: degrees clockwise from magnetic north. Already a heading. */
  webkitCompassHeading?: number | null;
  /** iOS only: negative means the reading is unusable. */
  webkitCompassAccuracy?: number | null;
}

function normalise(deg: number): number {
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * Degrees clockwise from north that the top of the device points, or null.
 *
 * iOS is checked first: `webkitCompassHeading` is already a compass heading,
 * and on iOS `alpha` is relative even when `absolute` is somehow set — trusting
 * alpha there would silently produce a wrong scope on the platform most of
 * these players are using.
 *
 * The standard path inverts alpha. `alpha` counts ANTICLOCKWISE from north, so
 * a device facing east reports 270, not 90. Using it directly mirrors the whole
 * instrument, which is the kind of bug that looks almost right.
 */
export function headingFromEvent(e: OrientationLike): number | null {
  const ios = e.webkitCompassHeading;
  if (typeof ios === "number" && Number.isFinite(ios)) {
    // A negative accuracy is iOS saying the magnetometer is uncalibrated.
    const acc = e.webkitCompassAccuracy;
    if (typeof acc === "number" && acc < 0) return null;
    return normalise(ios);
  }

  if (e.absolute !== true) return null;

  const alpha = e.alpha;
  if (typeof alpha !== "number" || !Number.isFinite(alpha)) return null;

  return normalise(360 - alpha);
}

/**
 * Smallest signed turn from `from` to `to`, in degrees, in (-180, 180].
 *
 * Used so a heading that crosses north animates the short way round rather
 * than spinning 350 degrees backwards — the visual tell of a compass someone
 * implemented by interpolating raw degrees.
 */
export function shortestTurn(from: number, to: number): number {
  const delta = normalise(to - from);
  return delta > 180 ? delta - 360 : delta;
}

/**
 * Where a bearing sits on screen once the scope is rotated to the heading.
 *
 * In heading-up mode the player is always facing "up", so a spawn dead ahead
 * must draw at 0. With no heading the scope is north-up and the bearing is
 * used unchanged.
 */
export function screenAngle(
  bearingDeg: number,
  headingDeg: number | null,
): number {
  return normalise(headingDeg === null ? bearingDeg : bearingDeg - headingDeg);
}

/** A coarse compass word for the direction to walk, for the text readout. */
export function compassWord(angleDeg: number, lang: "es" | "en"): string {
  const a = normalise(angleDeg);
  const EN = [
    "ahead",
    "ahead right",
    "right",
    "behind right",
    "behind",
    "behind left",
    "left",
    "ahead left",
  ];
  const ES = [
    "al frente",
    "al frente a la derecha",
    "a la derecha",
    "atrás a la derecha",
    "atrás",
    "atrás a la izquierda",
    "a la izquierda",
    "al frente a la izquierda",
  ];
  // Eight 45-degree sectors, offset so "ahead" spans -22.5..22.5 rather than
  // starting at 0 — otherwise something directly ahead reads as "ahead right".
  const sector = Math.round(a / 45) % 8;
  return (lang === "es" ? ES : EN)[sector];
}
