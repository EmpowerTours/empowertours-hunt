"use client";

import { useId, useMemo } from "react";
import { bandStyle } from "./bands";
import {
  formatCountdown,
  formatMeters,
  formatMon,
  weiOrZero,
} from "@/components/hunt/format";
import { compassPoint, projectToScope } from "@/components/hunt/geo";
import { screenAngle } from "@/lib/hunt/heading";
import type { GeoFix, HintBand, PublicSpawn } from "@/components/hunt/types";

/* ---------------------------------------------------------------------------
   The scope.

   TWO KINDS OF INFORMATION, RENDERED DELIBERATELY DIFFERENTLY:

   1. CACHES are hidden. The server sends a band and nothing else, so there is
      no bearing to draw and there never will be. The instrument itself carries
      the reading — sweep rate, colour, ring pulse, which range ring is lit.
      There is no cache marker anywhere in this file. Inventing a blip at a
      plausible-looking bearing would be lying to the player about data we
      deliberately refuse to hold.

   2. SPAWNS are public. Real coordinates, real bearings, real distances,
      plotted exactly. A visible countdown to expiry, because the whole
      mechanic is "get there before it goes".

   That contrast is the screen: vague heat for the hidden thing, hard blips for
   the visible one.

   PERFORMANCE CONTRACT: only `transform` and `opacity` are animated, and every
   glow is a radial gradient rather than an SVG filter — a filter on an animated
   node re-rasterises every frame and is what turns a scope into a slideshow on
   a mid-range phone. Do not add feGaussianBlur here.
--------------------------------------------------------------------------- */

const RIM = 96;
const RING_RADII = [24, 48, 72, 96] as const;
const SWEEP_SLICES = 14;

type CssVars = React.CSSProperties & Record<`--${string}`, string>;

export interface SpawnMark {
  spawn: PublicSpawn;
  distanceMeters: number;
  bearingDeg: number;
  /** True when the player is inside the spawn's collect radius. */
  inReach: boolean;
}

export interface RadarScopeProps {
  /** Server-reported warmth for the nearest unfound cache. Null = no reading. */
  band: HintBand | null;
  /** Every cache in this hunt has been found. */
  complete?: boolean;
  /** Meters from centre to rim. */
  rangeMeters: number;
  fix: GeoFix | null;
  spawns: readonly SpawnMark[];
  selectedSpawnId?: string | null;
  /**
   * Degrees clockwise from north the device is facing, or null.
   *
   * Null means north-up: the scope cannot honestly claim to know which way the
   * player is pointing, so it does not rotate and the caller says so.
   */
  headingDeg?: number | null;
  onSelectSpawn?: (spawnId: string) => void;
  /** Ticking clock, passed in so one timer drives every countdown on screen. */
  now: number;
}

/** Wedge from a0 to a1 (degrees, screen space: 0 = east, clockwise). */
function wedgePath(a0: number, a1: number, r: number): string {
  const toXY = (deg: number): string => {
    const rad = (deg * Math.PI) / 180;
    return `${(Math.cos(rad) * r).toFixed(2)} ${(Math.sin(rad) * r).toFixed(2)}`;
  };
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M0 0L${toXY(a0)}A${r} ${r} 0 ${large} 1 ${toXY(a1)}Z`;
}

export function RadarScope({
  band,
  complete = false,
  rangeMeters,
  fix,
  spawns,
  selectedSpawnId = null,
  headingDeg = null,
  onSelectSpawn,
  now,
}: RadarScopeProps) {
  const uid = useId().replace(/:/g, "");
  const style = bandStyle(complete ? null : band);

  // Nearest live spawn, for the bearing pointer. Expired ones are excluded
  // here rather than in the pointer so it cannot aim at something the blip
  // layer has already stopped drawing.
  const nearest = useMemo(() => {
    let best: SpawnMark | null = null;
    for (const mark of spawns) {
      if (new Date(mark.spawn.expiresAt).getTime() - now <= 0) continue;
      if (best === null || mark.distanceMeters < best.distanceMeters) best = mark;
    }
    return best;
  }, [spawns, now]);

  // The sweep tail. Rebuilt only when the band changes the tail length, so the
  // animation itself never re-renders React.
  const slices = useMemo(() => {
    const step = style.tailDegrees / SWEEP_SLICES;
    return Array.from({ length: SWEEP_SLICES }, (_, i) => {
      // Leading edge points north (screen -90deg); the tail trails behind it.
      const a0 = -90 - style.tailDegrees + i * step;
      const falloff = (i + 1) / SWEEP_SLICES;
      return {
        d: wedgePath(a0, a0 + step + 0.4, RIM),
        opacity: style.sweepOpacity * falloff * falloff,
      };
    });
  }, [style.tailDegrees, style.sweepOpacity]);

  const spokes = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) => {
        const rad = ((i * 30 - 90) * Math.PI) / 180;
        const inner = i % 3 === 0 ? 0 : RIM - 7;
        return {
          x1: Math.cos(rad) * inner,
          y1: Math.sin(rad) * inner,
          x2: Math.cos(rad) * RIM,
          y2: Math.sin(rad) * RIM,
          major: i % 3 === 0,
        };
      }),
    [],
  );

  // GPS accuracy drawn to scale. An honest instrument shows how blurry its own
  // input is; a scope that hides a 60m error ring is selling certainty it does
  // not have.
  const accuracyRadius =
    fix && rangeMeters > 0
      ? Math.min((fix.accuracyM / rangeMeters) * RIM, RIM)
      : 0;

  const vars: CssVars = {
    "--band": style.color,
    "--sweep-dur": `${style.sweepSeconds}s`,
    "--pulse-dur": `${style.pulseSeconds}s`,
    "--breathe-dur": `${style.breatheSeconds}s`,
  };

  const ariaLabel = complete
    ? "Radar scope: every cache in this hunt has been found."
    : band === null
      ? "Radar scope: no proximity reading yet."
      : `Radar scope: proximity reading ${style.label}. ${spawns.length} spawn${spawns.length === 1 ? "" : "s"} in view.`;

  return (
    <svg
      viewBox="-112 -112 224 224"
      className="scope"
      style={vars}
      role="img"
      aria-label={ariaLabel}
    >
      <defs>
        {/* Glass — the dark dish itself. */}
        <radialGradient id={`glass-${uid}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#0b2822" stopOpacity="0.95" />
          <stop offset="62%" stopColor="#061418" stopOpacity="0.98" />
          <stop offset="100%" stopColor="#03080a" stopOpacity="1" />
        </radialGradient>

        {/* Heat. Centred on the PLAYER, because the reading is about the
            player's position, not about a location we claim to know. */}
        <radialGradient id={`heat-${uid}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={style.color} stopOpacity="0.55" />
          <stop offset="45%" stopColor={style.color} stopOpacity="0.16" />
          <stop offset="100%" stopColor={style.color} stopOpacity="0" />
        </radialGradient>

        {/* Sweep body — bright at the hub, thinning toward the rim. */}
        <radialGradient id={`sweep-${uid}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={style.color} stopOpacity="0.85" />
          <stop offset="100%" stopColor={style.color} stopOpacity="0.15" />
        </radialGradient>

        <radialGradient id={`blip-${uid}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffd12e" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#ffd12e" stopOpacity="0" />
        </radialGradient>

        {/* Everything inside the dish is clipped to it, so a sweep slice or an
            off-scope marker can never paint over the chrome. */}
        <clipPath id={`dish-${uid}`}>
          <circle cx="0" cy="0" r={RIM} />
        </clipPath>
      </defs>

      {/* --- Dish -------------------------------------------------------- */}
      <circle cx="0" cy="0" r={RIM} fill={`url(#glass-${uid})`} />

      <g clipPath={`url(#dish-${uid})`}>
        {/* Ambient hum. Slow at cold, urgent at burning. */}
        <circle
          cx="0"
          cy="0"
          r={RIM}
          fill={`url(#heat-${uid})`}
          className="scope-breathe"
        />

        {/* Range rings. The lit one is the reading: it tightens toward the
            centre as the player warms. */}
        {RING_RADII.map((r, i) => {
          const lit = style.litRing === i;
          return (
            <g key={r}>
              {lit && (
                <circle
                  cx="0"
                  cy="0"
                  r={r}
                  fill="none"
                  stroke={style.color}
                  strokeWidth="4"
                  opacity="0.16"
                  className="scope-breathe"
                />
              )}
              <circle
                cx="0"
                cy="0"
                r={r}
                fill="none"
                stroke={lit ? style.color : "#1d6b53"}
                strokeWidth={lit ? 1.4 : 0.6}
                opacity={lit ? 0.95 : 0.42}
              />
            </g>
          );
        })}

        {/* Graticule. */}
        {spokes.map((s, i) => (
          <line
            key={i}
            x1={s.x1}
            y1={s.y1}
            x2={s.x2}
            y2={s.y2}
            stroke="#1d6b53"
            strokeWidth={s.major ? 0.5 : 0.7}
            opacity={s.major ? 0.3 : 0.5}
          />
        ))}

        {/* Range-ring pulse. Off entirely below `warm`, so the rhythm arriving
            is itself the news. */}
        {style.pulseSeconds > 0 && (
          <>
            <circle
              cx="0"
              cy="0"
              r={RIM}
              fill="none"
              stroke={style.color}
              strokeWidth="1.6"
              className="scope-pulse"
            />
            <circle
              cx="0"
              cy="0"
              r={RIM}
              fill="none"
              stroke={style.color}
              strokeWidth="1.6"
              className="scope-pulse scope-pulse-2"
            />
          </>
        )}

        {/* Sweep. */}
        <g className="scope-sweep">
          {slices.map((s, i) => (
            <path
              key={i}
              d={s.d}
              fill={`url(#sweep-${uid})`}
              opacity={s.opacity}
            />
          ))}
          <line
            x1="0"
            y1="0"
            x2="0"
            y2={-RIM}
            stroke={style.color}
            strokeWidth="0.9"
            opacity="0.9"
          />
          <circle
            cx="0"
            cy={-RIM + 2}
            r="1.6"
            fill={style.color}
            opacity="0.9"
          />
        </g>

        {/* GPS uncertainty, to scale. */}
        {accuracyRadius > 1 && (
          <circle
            cx="0"
            cy="0"
            r={accuracyRadius}
            fill={style.color}
            fillOpacity="0.05"
            stroke={style.color}
            strokeWidth="0.5"
            strokeDasharray="2 3"
            opacity="0.5"
          />
        )}

        {/* --- Spawns: real bearings, real distances. -------------------
            In heading-up mode the whole layer counter-rotates, so a spawn the
            player is facing sits at the top of the dish. The blips keep their
            TRUE bearings; only the frame of reference moves. */}
        {fix &&
          spawns.map((mark) => (
            <SpawnBlip
              key={mark.spawn.id}
              mark={mark}
              screenAngleDeg={screenAngle(mark.bearingDeg, headingDeg)}
              rangeMeters={rangeMeters}
              selected={selectedSpawnId === mark.spawn.id}
              onSelect={onSelectSpawn}
              now={now}
              gradientId={`blip-${uid}`}
            />
          ))}
      </g>

      {/* --- Player, drawn above the clip so it is never occluded. -------- */}
      <g>
        <circle
          cx="0"
          cy="0"
          r="4.5"
          fill="none"
          stroke="#46ffbe"
          strokeWidth="0.7"
          opacity="0.7"
        />
        <path
          d="M0 -3.2 L2.6 3 L0 1.5 L-2.6 3 Z"
          fill="#46ffbe"
          opacity={fix ? 1 : 0.28}
        />
      </g>

      {/* --- North marker: the compass affordance. ------------------------
          In heading-up mode this is the only thing on the dish that tells the
          player which way north actually is, and it is what makes the rotation
          legible as a compass rather than as drift. Hidden in north-up mode,
          where "up" already means north and a second indicator saying the same
          thing is noise. */}
      {headingDeg !== null && (
        <g transform={`rotate(${-headingDeg})`} opacity="0.75">
          <path
            d={`M0 ${-(RIM - 1)} L2.6 ${-(RIM - 6)} L-2.6 ${-(RIM - 6)} Z`}
            fill="#8fb7ff"
          />
          <text
            x="0"
            y={-(RIM - 10)}
            textAnchor="middle"
            fontSize="6"
            fontFamily="ui-monospace, monospace"
            fill="#8fb7ff"
          >
            N
          </text>
        </g>
      )}

      {/* --- Bearing pointer: which way to walk. --------------------------
          The nearest live spawn gets a arrow on the rim, sized to be read at
          arm's length in sunlight. The blips are truthful but small; this is
          the one mark on the instrument that answers the only question a
          player standing on a street actually has. */}
      {fix && nearest !== null && (
        <g transform={`rotate(${screenAngle(nearest.bearingDeg, headingDeg)})`}>
          <path
            d={`M0 ${-(RIM - 12)} L7 ${-(RIM - 25)} L0 ${-(RIM - 21)} L-7 ${-(RIM - 25)} Z`}
            fill="#ffd12e"
            opacity="0.95"
            className="scope-breathe"
          />
        </g>
      )}

      {/* --- Chrome ------------------------------------------------------ */}
      <circle
        cx="0"
        cy="0"
        r={RIM}
        fill="none"
        stroke={style.color}
        strokeWidth="1"
        opacity="0.55"
      />
      {style.alarm && (
        <circle
          cx="0"
          cy="0"
          r={RIM + 4}
          fill="none"
          stroke="#ff3b30"
          strokeWidth="1.6"
          strokeDasharray="6 4"
          className="scope-alarm"
        />
      )}

      {/* Bearing labels. North-up: no compass permission prompt, no fake
          heading when the magnetometer is confused by a phone case. */}
      {(
        [
          ["N", 0],
          ["E", 90],
          ["S", 180],
          ["W", 270],
        ] as const
      ).map(([label, deg]) => {
        const rad = ((deg - 90) * Math.PI) / 180;
        return (
          <text
            key={label}
            x={Math.cos(rad) * (RIM + 11)}
            y={Math.sin(rad) * (RIM + 11)}
            textAnchor="middle"
            dominantBaseline="central"
            className="font-mono"
            fontSize="8"
            fill={label === "N" ? style.color : "#47645d"}
            opacity={label === "N" ? 0.95 : 0.8}
          >
            {label}
          </text>
        );
      })}

      {/* Range readout, on the rim where a scope puts it. */}
      <text
        x="0"
        y={RIM + 11}
        textAnchor="middle"
        dominantBaseline="central"
        className="font-mono"
        fontSize="7"
        fill="#78a094"
      >
        {`RNG ${formatMeters(rangeMeters)}`}
      </text>
    </svg>
  );
}

/* --- Spawn blip ----------------------------------------------------------- */

function SpawnBlip({
  mark,
  screenAngleDeg,
  rangeMeters,
  selected,
  onSelect,
  now,
  gradientId,
}: {
  mark: SpawnMark;
  screenAngleDeg: number;
  rangeMeters: number;
  selected: boolean;
  onSelect?: (id: string) => void;
  now: number;
  gradientId: string;
}) {
  // The SCREEN angle, not the bearing: in heading-up mode these differ by the
  // device heading, and drawing at the raw bearing would put the blip in the
  // right compass direction on a dish that is no longer north-up.
  const { x, y, offScope } = projectToScope(
    screenAngleDeg,
    mark.distanceMeters,
    rangeMeters,
    RIM - 4,
  );

  const msLeft = new Date(mark.spawn.expiresAt).getTime() - now;
  if (!Number.isFinite(msLeft) || msLeft <= 0) return null;

  const expiring = msLeft < 60_000;
  const amount = formatMon(weiOrZero(mark.spawn.amountMonWei), 4);

  return (
    <g
      transform={`translate(${x.toFixed(2)} ${y.toFixed(2)})`}
      onClick={onSelect ? () => onSelect(mark.spawn.id) : undefined}
      style={onSelect ? { cursor: "pointer" } : undefined}
    >
      {/* Generous invisible tap target — this is used outdoors, one-handed. */}
      <circle cx="0" cy="0" r="15" fill="transparent" />

      <circle cx="0" cy="0" r="11" fill={`url(#${gradientId})`} opacity="0.5" />
      <circle
        cx="0"
        cy="0"
        r="4"
        fill="none"
        stroke="#ffd12e"
        strokeWidth="0.9"
        className="blip-ping"
      />

      {offScope ? (
        // Past the current range: a chevron on the rim, never a dot at a
        // distance we would have had to invent.
        <path
          d="M0 -5 L4 3 L-4 3 Z"
          fill="#ffd12e"
          transform={`rotate(${screenAngleDeg})`}
          opacity="0.9"
        />
      ) : (
        <circle
          cx="0"
          cy="0"
          r={selected ? 4 : 2.8}
          fill="#ffd12e"
          className="blip-core"
        />
      )}

      {selected && (
        <circle
          cx="0"
          cy="0"
          r="8"
          fill="none"
          stroke="#ffd12e"
          strokeWidth="0.8"
          opacity="0.9"
        />
      )}

      {mark.inReach && (
        <circle
          cx="0"
          cy="0"
          r="7"
          fill="none"
          stroke="#46ffbe"
          strokeWidth="1.2"
          opacity="0.95"
        />
      )}

      <text
        x="0"
        y="-11"
        textAnchor="middle"
        className="font-mono"
        fontSize="6"
        fill="#ffd12e"
      >
        {amount}
      </text>
      <text
        x="0"
        y="15"
        textAnchor="middle"
        className="font-mono"
        fontSize="6"
        fill={expiring ? "#ff3b30" : "#78a094"}
      >
        {formatCountdown(msLeft)}
      </text>
    </g>
  );
}

/** Exported for the spawn list beside the scope. */
export function spawnHeadingLabel(mark: SpawnMark): string {
  return `${compassPoint(mark.bearingDeg)} · ${formatMeters(mark.distanceMeters)}`;
}
