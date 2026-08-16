import { haversineMeters, type LatLng } from "@/lib/geo/distance";

/* ---------------------------------------------------------------------------
   Turning an operator standing in a field into a cache coordinate.

   `CacheManager` takes lat/lng as typed text. Somebody has to produce those
   digits, and the honest way is to stand on the spot and read the phone — but
   a single GPS fix is not a location, it is a guess with a radius. This
   condenses a stream of fixes into one coordinate and, more importantly, says
   how much to trust it.

   Pure, no React, no DOM, no network: a quiet bug here misplaces a cache and
   nobody finds out until a player is standing in the wrong street failing to
   claim, which reads as a broken geofence rather than a bad coordinate.

   Nothing here is a security control — the coordinates it produces are secret,
   but it only ever runs on an operator's own device and posts nothing. The
   value is accuracy, not secrecy.
--------------------------------------------------------------------------- */

/**
 * Fixes looser than this are not worth averaging in. Stricter than any claim
 * path on purpose: a player is walking past and takes what they get, an
 * operator is standing still and can afford to wait for a better fix.
 */
export const MAX_SURVEY_ACCURACY_M = 60;

/** Enough fixes to see whether they agree. Below this the spread is noise. */
export const MIN_SAMPLES_FOR_FIX = 8;

/** Fixes agreeing this closely mean the receiver has settled. */
export const GOOD_SPREAD_M = 15;

/** A fix this far from the running mean means the operator walked off. */
export const MOVED_AWAY_M = 100;

/** Fixes older than this are from a previous stop, not this one. */
export const SAMPLE_TTL_MS = 3 * 60 * 1000;

/** Bounds the buffer on a page left open all afternoon. */
export const MAX_SAMPLES = 120;

export interface Sample extends LatLng {
  /** Metres, the browser's 68% confidence radius. */
  accuracyM: number;
  /** Epoch milliseconds. */
  at: number;
}

export interface SurveyFix extends LatLng {
  /** How many fixes went into the mean. */
  samples: number;
  /** The tightest single fix. */
  bestAccuracyM: number;
  /** Furthest any fix sits from the mean — how much they disagree. */
  spreadM: number;
}

export type FixQuality = "waiting" | "rough" | "good";

/**
 * States the accept condition and is negated by callers, per the reject-by-
 * default rule: every comparison here is positive, so a NaN falls out as
 * unusable instead of slipping through a `> max` test that is false for NaN.
 */
export function isUsableSample(s: Sample): boolean {
  return (
    Number.isFinite(s.lat) &&
    Number.isFinite(s.lng) &&
    Math.abs(s.lat) <= 90 &&
    Math.abs(s.lng) <= 180 &&
    Number.isFinite(s.accuracyM) &&
    s.accuracyM > 0 &&
    s.accuracyM <= MAX_SURVEY_ACCURACY_M
  );
}

/**
 * Weighted mean of the usable fixes, weighting each by 1/accuracy² so a 5m fix
 * counts a hundred times a 50m one.
 *
 * Two limits worth stating rather than hiding. The mean is arithmetic, which
 * holds at Guerrero latitudes but is not a general geodesic mean — it would be
 * wrong near a pole or across the antimeridian. And the spread is reported
 * instead of a combined error bar because consecutive fixes from one receiver
 * share the same multipath bias; they are not independent, so the usual
 * 1/sqrt(n) improvement would be a lie. A tight spread means the receiver
 * settled, not that the answer is correct.
 */
export function averagePosition(samples: readonly Sample[]): SurveyFix | null {
  const usable = samples.filter(isUsableSample);
  if (usable.length === 0) return null;

  let weightSum = 0;
  let latSum = 0;
  let lngSum = 0;

  for (const s of usable) {
    // Floor the accuracy so an optimistic sub-metre fix cannot dominate.
    const sigma = Math.max(s.accuracyM, 1);
    const w = 1 / (sigma * sigma);
    weightSum += w;
    latSum += s.lat * w;
    lngSum += s.lng * w;
  }

  const lat = latSum / weightSum;
  const lng = lngSum / weightSum;

  let spreadM = 0;
  for (const s of usable) {
    const d = haversineMeters({ lat, lng }, { lat: s.lat, lng: s.lng });
    if (d > spreadM) spreadM = d;
  }

  let bestAccuracyM = Infinity;
  for (const s of usable) {
    if (s.accuracyM < bestAccuracyM) bestAccuracyM = s.accuracyM;
  }

  return { lat, lng, samples: usable.length, bestAccuracyM, spreadM };
}

/**
 * Add a fix to the buffer.
 *
 * Starts over when the operator has plainly moved, because averaging two
 * different street corners produces a confident coordinate for a spot that is
 * neither of them — the worst failure available here, since the result looks
 * entirely healthy.
 */
export function appendSample(
  samples: readonly Sample[],
  next: Sample,
): Sample[] {
  if (!isUsableSample(next)) return [...samples];

  const fresh = samples.filter((s) => next.at - s.at <= SAMPLE_TTL_MS);
  const mean = averagePosition(fresh);

  if (
    mean &&
    haversineMeters(
      { lat: mean.lat, lng: mean.lng },
      { lat: next.lat, lng: next.lng },
    ) > MOVED_AWAY_M
  ) {
    return [next];
  }

  return [...fresh, next].slice(-MAX_SAMPLES);
}

export function fixQuality(fix: SurveyFix | null): FixQuality {
  if (!fix || fix.samples < MIN_SAMPLES_FOR_FIX) return "waiting";
  return fix.spreadM <= GOOD_SPREAD_M ? "good" : "rough";
}

/** Six decimals is ~0.11m — finer than any phone, short enough to read. */
export function formatCoordinate(n: number): string {
  return n.toFixed(6);
}

export interface CacheDraft {
  lat: string;
  lng: string;
  radiusMeters: string;
}

/**
 * The values to type into `CacheManager`, as strings because that form holds
 * its draft as text and parses on submit.
 */
export function toCacheDraft(fix: SurveyFix, radiusMeters: number): CacheDraft {
  return {
    lat: formatCoordinate(fix.lat),
    lng: formatCoordinate(fix.lng),
    radiusMeters: String(radiusMeters),
  };
}
