// ---------------------------------------------------------------------------
// Chip Board math for DISPLAY ONLY.
//
// The Go server (services/chipboard/internal/engine/math.go) is the judge: it
// fixes the baseline at lock and scores every round. The client uses these
// functions for two things only, both labelled as previews on screen:
//   * the "points if it lands here" column on the open round, measured against
//     the default spread as it stands now (the real baseline is set at lock);
//   * drawing locked rounds and explaining a result the server already sent.
// Nothing here is ever sent to the server or shown as a score.
// ---------------------------------------------------------------------------

export const NB = 12;
export const CHIPS = 100;

// Abramowitz-Stegun erf, as in the approved mockup. Preview precision only.
function erf(x: number): number {
  const s = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return s * y;
}
const phi = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));

/** A normal(mu, sd) cut into the 12 bands at the 11 inner edges. */
export function baseline(edges: number[], mu: number, sd: number): number[] {
  const cdf = (x: number) => phi((x - mu) / sd);
  const b = new Array<number>(NB);
  b[0] = cdf(edges[0]);
  for (let k = 1; k <= NB - 2; k++) b[k] = cdf(edges[k]) - cdf(edges[k - 1]);
  b[NB - 1] = 1 - cdf(edges[NB - 2]);
  return b;
}

/** Band holding p: 0 below edges[0], 11 at or above edges[10]. */
export function bandOf(edges: number[], p: number): number {
  if (p < edges[0]) return 0;
  if (p >= edges[NB - 2]) return NB - 1;
  for (let k = 1; k <= NB - 2; k++) if (p < edges[k]) return k;
  return NB - 1;
}

export const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

/** Placed chips as shares; chips still in hand are spread like the baseline. */
export function shares(chips: number[], base: number[]): number[] {
  const left = CHIPS - sum(chips);
  return chips.map((c, i) => (c + left * base[i]) / CHIPS);
}

const brier = (q: number[], k: number) =>
  2 * q[k] - q.reduce((a, x) => a + x * x, 0);

/** Preview of the points if the price lands in band k (Brier vs the baseline). */
export function previewPoints(chips: number[], base: number[], k: number) {
  return Math.round(100 * (brier(shares(chips, base), k) - brier(base, k)));
}

/** The default spread as whole chips, as the mockup's "Default spread" button. */
export function defaultSpread(base: number[]): number[] {
  const c = base.map((b) => Math.floor(b * CHIPS));
  let left = CHIPS - sum(c);
  // Hand the remainder out one chip at a time to the likely bands. If no band
  // is above 5% (cannot happen with 12 bands, but never loop forever), stop.
  if (!base.some((b) => b > 0.05)) return c;
  for (let i = 0; left > 0; i = (i + 1) % NB)
    if (base[i] > 0.05) {
      c[i]++;
      left--;
    }
  return c;
}

/** "+12", "−7", "0" with a real minus sign. */
export const sgn = (x: number) =>
  (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x);
