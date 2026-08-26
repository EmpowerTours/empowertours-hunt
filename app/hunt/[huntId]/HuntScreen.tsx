"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useClaimSigner } from "@/app/providers";
import { useGeolocation } from "@/components/hooks/useGeolocation";
import { useHint } from "@/components/hooks/useHint";
import { useTicker } from "@/components/hooks/useTicker";
import { BandReadout } from "@/components/hunt/BandReadout";
import {
  ClaimButton,
  claimGate,
  type ClaimPhase,
} from "@/components/hunt/ClaimButton";
import { FindReveal } from "@/components/hunt/FindReveal";
import { FixReadout } from "@/components/hunt/FixReadout";
import { SpawnPanel } from "@/components/hunt/SpawnPanel";
import {
  ApiError,
  SignerMissingError,
  collectSpawn,
  fetchHunt,
  scanSpawns,
  submitClaim,
} from "@/components/hunt/client";
import { isTerminalSpawnReason, refusalCopy } from "@/components/hunt/copy";
import { useSpawnReason } from "@/components/hunt/useSpawnReason";
import { LanguageSwitch } from "@/components/hunt/LanguageSwitch";
import { useTranslations } from "next-intl";
import {
  bearingDegrees,
  haversineMeters,
  pickRange,
} from "@/components/hunt/geo";
import type {
  ClaimFound,
  ClaimRefusalReason,
  PublicHunt,
  PublicSpawn,
} from "@/components/hunt/types";
import { RadarScope, type SpawnMark } from "@/components/radar/RadarScope";
import { Note } from "@/components/ui/primitives";

/* ---------------------------------------------------------------------------
   The hunt screen.

   Owns exactly one GPS watch, one 1-second clock, one throttled hint poll and
   one slow spawn scan. Nothing below it opens a timer of its own.

   RATE-LIMIT BUDGET (lib/ratelimit.ts, per player per minute):
     hint  12  — useHint self-throttles to at most 10
     claim  5  — user-initiated only
     spawn  6  — SHARED between scanning and collecting. The scan runs every
                 30s (2/min), leaving four tokens for collects. Polling faster
                 would mean a player can be rate-limited out of collecting the
                 drop they just walked to, which is the one thing that actually
                 costs them money.
--------------------------------------------------------------------------- */

const SPAWN_SCAN_MS = 30_000;

/** Used until `GET /api/hunt/[huntId]` exists. Matches the schema defaults. */
const FALLBACK_HUNT = {
  maxAccuracyM: 30,
  cooldownSeconds: 60,
} as const;

export function HuntScreen({ huntId }: { huntId: string }) {
  const now = useTicker(1_000);
  const signer = useClaimSigner();
  const geo = useGeolocation(true);
  const fix = geo.fix;

  /* --- Hunt metadata ---------------------------------------------------- */
  const [hunt, setHunt] = useState<PublicHunt | null>(null);
  const [huntMissing, setHuntMissing] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchHunt(huntId, controller.signal)
      .then(setHunt)
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        if (e instanceof ApiError && e.notImplemented) setHuntMissing(true);
      });
    return () => controller.abort();
  }, [huntId]);

  const maxAccuracyM = hunt?.maxAccuracyM ?? FALLBACK_HUNT.maxAccuracyM;
  const cooldownSeconds =
    hunt?.cooldownSeconds ?? FALLBACK_HUNT.cooldownSeconds;
  const huntActive = hunt?.active ?? true;

  /* --- Proximity -------------------------------------------------------- */
  const hint = useHint(huntId, fix, huntActive);

  /* --- Spawns ----------------------------------------------------------- */
  const [spawns, setSpawns] = useState<PublicSpawn[]>([]);
  const [scanReason, setScanReason] = useState<string | null>(null);
  const [scanStopped, setScanStopped] = useState(false);
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const [selectedSpawnId, setSelectedSpawnId] = useState<string | null>(null);
  const spawnReason = useSpawnReason();
  const tPayout = useTranslations("payout");
  const tGps = useTranslations("gps");
  const [collectingId, setCollectingId] = useState<string | null>(null);
  const [collectNote, setCollectNote] = useState<string | null>(null);
  const [scanTick, setScanTick] = useState(0);

  // Whether the hunt even has spawns is only knowable from hunt metadata that
  // does not exist yet, so the first scan runs regardless and the server's own
  // `spawn_disabled` answer stops it. Guessing "off" would hide a live mechanic;
  // guessing "on" forever would burn rate-limit tokens.
  const scanEnabled = huntActive && !scanStopped;

  useEffect(() => {
    if (!scanEnabled) return;
    const id = window.setInterval(
      () => setScanTick((n) => n + 1),
      SPAWN_SCAN_MS,
    );
    return () => window.clearInterval(id);
  }, [scanEnabled]);

  useEffect(() => {
    if (!scanEnabled) return;
    const controller = new AbortController();
    scanSpawns(huntId, controller.signal)
      .then((result) => {
        setSpawns(result.spawns);
        setScanReason(result.spawned ? null : result.reason);
        setSpawnError(null);
        if (isTerminalSpawnReason(result.reason)) setScanStopped(true);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        if (e instanceof ApiError && e.status === 401) {
          setScanStopped(true);
          setSpawnError("Sign in to receive spawns.");
          return;
        }
        // A 429 here is self-inflicted only if something else is scanning; back
        // off rather than hammering a money-path limiter.
        if (e instanceof ApiError && e.status === 429) return;
        setSpawnError(
          e instanceof ApiError ? e.message : "Could not reach the spawn feed.",
        );
      });
    return () => controller.abort();
  }, [huntId, scanEnabled, scanTick]);

  // Bearings and distances are computed once here and shared by the scope and
  // the list, so the two can never disagree about where a blip is.
  const marks = useMemo<SpawnMark[]>(() => {
    if (fix === null) return [];
    return spawns
      .filter((s) => new Date(s.expiresAt).getTime() > now)
      .map((spawn) => {
        const distanceMeters = haversineMeters(fix, spawn);
        return {
          spawn,
          distanceMeters,
          bearingDeg: bearingDegrees(fix, spawn),
          inReach: distanceMeters <= spawn.radiusMeters,
        };
      })
      .sort((a, b) => a.distanceMeters - b.distanceMeters);
  }, [spawns, fix, now]);

  const rangeMeters = useMemo(() => {
    const furthest = marks.reduce(
      (max, m) => Math.max(max, m.distanceMeters),
      0,
    );
    return pickRange(furthest, 500);
  }, [marks]);

  /* --- Claiming --------------------------------------------------------- */
  const [phase, setPhase] = useState<ClaimPhase>("idle");
  const [refusal, setRefusal] = useState<ClaimRefusalReason | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [find, setFind] = useState<ClaimFound | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const claimAbort = useRef<AbortController | null>(null);

  useEffect(() => () => claimAbort.current?.abort(), []);

  const cooldownSecondsLeft = Math.max(
    0,
    Math.ceil((cooldownUntil - now) / 1000),
  );

  const gate = claimGate({
    fix,
    maxAccuracyM,
    phase,
    cooldownSecondsLeft,
    complete: hint.complete,
    huntActive,
  });

  const onClaim = useCallback(async () => {
    if (fix === null || !gate.ready) return;

    setRefusal(null);
    setClaimError(null);
    claimAbort.current?.abort();
    const controller = new AbortController();
    claimAbort.current = controller;

    // Signing is its own phase because a passkey prompt takes a visible moment,
    // and a button that says "checking" through a Face ID sheet reads as a hang.
    setPhase(signer ? "signing" : "submitting");

    try {
      const result = await submitClaim(huntId, fix, signer, controller.signal);
      if (controller.signal.aborted) return;

      if (result.found) {
        setFind(result);
        setCooldownUntil(Date.now() + cooldownSeconds * 1_000);
        hint.refresh();
      } else {
        setRefusal(result.reason);
      }
    } catch (e: unknown) {
      if (controller.signal.aborted) return;
      setClaimError(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : "The claim could not be sent.",
      );
    } finally {
      if (!controller.signal.aborted) setPhase("idle");
    }
  }, [fix, gate.ready, signer, huntId, cooldownSeconds, hint]);

  const onCollect = useCallback(
    async (spawnId: string) => {
      if (fix === null) return;
      setCollectingId(spawnId);
      setSpawnError(null);
      setCollectNote(null);
      try {
        const result = await collectSpawn(huntId, spawnId, fix, signer);
        if (result.collected) {
          setSpawns((list) => list.filter((s) => s.id !== spawnId));
          setSelectedSpawnId(null);
          setCollectNote(
            result.payout.holdReason === null
              ? tPayout("released")
              : tPayout("held", { reason: result.payout.holdReason }),
          );
        } else {
          setSpawnError(spawnReason(result.reason));
        }
      } catch (e: unknown) {
        setSpawnError(
          e instanceof SignerMissingError
            ? tPayout("signerMissing")
            : e instanceof ApiError
              ? e.message
              : tPayout("failed"),
        );
      } finally {
        setCollectingId(null);
        setScanTick((n) => n + 1);
      }
    },
    [fix, huntId, signer],
  );

  // A refusal is transient. Leaving it on screen makes the player think it
  // still applies after they have walked somewhere else.
  useEffect(() => {
    if (refusal === null) return;
    const id = window.setTimeout(() => setRefusal(null), 12_000);
    return () => window.clearTimeout(id);
  }, [refusal]);

  const refusalText = refusal === null ? null : refusalCopy(refusal);

  return (
    <main className="safe-top safe-bottom mx-auto flex w-full max-w-md flex-col gap-4 px-4 pb-6">
      <header className="flex items-center justify-between gap-3 pt-2">
        <div className="min-w-0">
          <h1 className="text-ink truncate text-lg font-semibold">
            {hunt?.name ?? "Hunt"}
          </h1>
          <p className="text-ink-faint font-mono text-[11px] tracking-[0.16em] uppercase">
            {huntActive ? "Live" : "Closed"} · North-up scope
          </p>
        </div>
        <Link
          href="/hunt/wallet"
          className="border-hull-line text-ink-dim flex min-h-11 shrink-0 items-center rounded-xl border px-3 font-mono text-xs tracking-widest uppercase"
        >
          Wallet
        </Link>
      </header>

      <RadarScope
        band={hint.band}
        complete={hint.complete}
        rangeMeters={rangeMeters}
        fix={fix}
        spawns={marks}
        selectedSpawnId={selectedSpawnId}
        onSelectSpawn={setSelectedSpawnId}
        now={now}
      />

      <BandReadout
        band={hint.band}
        complete={hint.complete}
        remaining={hint.remaining}
        status={hint.status}
        error={hint.error}
      />

      <ClaimButton gate={gate} onClaim={() => void onClaim()} />

      {refusalText ? (
        <Note tone="warn" title={refusalText.title}>
          {refusalText.body}
        </Note>
      ) : null}

      {claimError ? (
        <Note tone="warn" title="Claim not sent">
          {claimError}
        </Note>
      ) : null}

      <LanguageSwitch className="flex justify-end" />

      <FixReadout
        fix={fix}
        status={geo.status}
        // The hook's own MESSAGES map stays English: lib/ has non-UI callers and
        // a status string is data. Only what reaches the screen is translated,
        // and only when the hook had something to say at all.
        message={geo.message === null ? null : tGps(geo.status)}
        maxAccuracyM={maxAccuracyM}
        now={now}
        onRetry={geo.retry}
      />

      {collectNote ? <Note title={tPayout("title")}>{collectNote}</Note> : null}

      <SpawnPanel
        marks={marks}
        now={now}
        selectedId={selectedSpawnId}
        onSelect={setSelectedSpawnId}
        onCollect={(id) => void onCollect(id)}
        collectingId={collectingId}
        scanReason={scanReason}
        stopped={scanStopped}
        error={spawnError}
        signingAvailable={signer !== null}
      />

      {huntMissing ? (
        <Note title="Hunt details unavailable">
          {`GET /api/hunt/${huntId} is not built yet, so this screen is using the schema defaults: ±${FALLBACK_HUNT.maxAccuracyM} m accuracy and a ${FALLBACK_HUNT.cooldownSeconds}s cooldown. The server still decides every claim.`}
        </Note>
      ) : null}

      {signer === null ? (
        <p className="text-ink-faint px-1 text-center text-xs leading-snug">
          Claims are unsigned in this build and spawn collection is unavailable
          — the EIP-712 signer has not been registered yet. The server remains
          the only thing that decides whether anything pays.
        </p>
      ) : null}

      {find ? <FindReveal find={find} onDismiss={() => setFind(null)} /> : null}
    </main>
  );
}
