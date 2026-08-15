import type { HintBand } from "@/components/hunt/types";

/* ---------------------------------------------------------------------------
   The band IS the signal.

   The server sends `{ band, remaining }` and nothing else — no distance, no
   bearing, no cache id — so the scope cannot plot a cache and must never
   pretend to. Instead the whole instrument reacts: colour, sweep rate, ring
   pulse, ambient hum and how many range rings are lit. A player reads
   "burning" off the machine's behaviour, the way you read a Geiger counter,
   not off a marker that claims to know where the thing is.

   Every value below feeds a CSS custom property. Nothing here can encode a
   direction, because there is no direction to encode.
--------------------------------------------------------------------------- */

export interface BandStyle {
  /** Short readout label. */
  label: string;
  /** One line of honest interpretation. Never quantified — band edges are
      jittered per player, so any number here would be a lie. */
  gloss: string;
  color: string;
  /** Seconds per sweep revolution. Faster = warmer. */
  sweepSeconds: number;
  /** Range-ring pulse period. 0 disables the pulse entirely. */
  pulseSeconds: number;
  /** Ambient hum period. */
  breatheSeconds: number;
  /**
   * Which range ring lights up, innermost first (0..3). -1 lights none.
   * This is the honest visual: the reading tightens toward the centre as the
   * player warms, and the centre is the PLAYER, not the cache.
   */
  litRing: number;
  /** Sweep tail length in degrees. A hot scope has a longer, brighter tail. */
  tailDegrees: number;
  /** Peak opacity of the sweep wedge. */
  sweepOpacity: number;
  /** Burning only: the rim flutters. */
  alarm: boolean;
}

export const BAND_STYLES: Record<HintBand, BandStyle> = {
  cold: {
    label: "COLD",
    gloss: "No return. Cover ground.",
    color: "#3d7ea6",
    sweepSeconds: 7.5,
    pulseSeconds: 0,
    breatheSeconds: 9,
    litRing: -1,
    tailDegrees: 42,
    sweepOpacity: 0.22,
    alarm: false,
  },
  cool: {
    label: "COOL",
    gloss: "Faint return. Keep moving.",
    color: "#1fbdd2",
    sweepSeconds: 6,
    pulseSeconds: 0,
    breatheSeconds: 7,
    litRing: 3,
    tailDegrees: 48,
    sweepOpacity: 0.28,
    alarm: false,
  },
  warm: {
    label: "WARM",
    gloss: "Something is out here with you.",
    color: "#9fe339",
    sweepSeconds: 4.2,
    pulseSeconds: 4.4,
    breatheSeconds: 5,
    litRing: 2,
    tailDegrees: 56,
    sweepOpacity: 0.34,
    alarm: false,
  },
  hot: {
    label: "HOT",
    gloss: "Close. Slow down and sweep the ground.",
    color: "#ff9d2e",
    sweepSeconds: 2.6,
    pulseSeconds: 2.6,
    breatheSeconds: 3,
    litRing: 1,
    tailDegrees: 66,
    sweepOpacity: 0.42,
    alarm: false,
  },
  burning: {
    label: "BURNING",
    gloss: "You are standing on it. Look down.",
    color: "#ff3b30",
    sweepSeconds: 1.15,
    pulseSeconds: 1.2,
    breatheSeconds: 1.6,
    litRing: 0,
    tailDegrees: 84,
    sweepOpacity: 0.55,
    alarm: true,
  },
};

/** The scope with no reading at all — no fix yet, or every cache found. */
export const NEUTRAL_STYLE: BandStyle = {
  label: "NO READING",
  color: "#46ffbe",
  gloss: "Waiting for a fix.",
  sweepSeconds: 8,
  pulseSeconds: 0,
  breatheSeconds: 10,
  litRing: -1,
  tailDegrees: 38,
  sweepOpacity: 0.16,
  alarm: false,
};

export function bandStyle(band: HintBand | null): BandStyle {
  return band === null ? NEUTRAL_STYLE : BAND_STYLES[band];
}
