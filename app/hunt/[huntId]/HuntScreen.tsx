"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useClaimSigner } from "@/app/providers";
import { useGeolocation } from "@/components/hooks/useGeolocation";
import { useHeading } from "@/components/hooks/useHeading";
import { useHint } from "@/components/hooks/useHint";
import { useTicker } from "@/components/hooks/useTicker";
import { BandReadout } from "@/components/hunt/BandReadout";
import {
  ClaimButton,
  useClaimGate,
  type ClaimPhase,
} from "@/components/hunt/ClaimButton";
import { FindReveal } from "@/components/hunt/FindReveal";
import { FixReadout } from "@/components/hunt/FixReadout";
import {
  EditionCard,
  type EditionOfferView,
} from "@/components/hunt/EditionCard";
import { payFromPasskey } from "@/lib/auth/signIn";
import { SpawnPanel } from "@/components/hunt/SpawnPanel";
import {
  ApiError,
  SignerMissingError,
  collectSpawn,
  fetchHunt,
  checkIn,
  scanSpawns,
  submitClaim,
} from "@/components/hunt/client";
import { isTerminalSpawnReason } from "@/components/hunt/copy";
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
import { formatMon, weiOrZero } from "@/components/hunt/format";

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

  // The compass. Null heading means north-up, and the header says so — a scope
  // that silently claims to be heading-up while pointing at an arbitrary
  // direction is worse than one the player knows to read against north.
  const compass = useHeading(true);

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
  // A REASON, not a sentence.
  //
  // This used to hold the translated string, set inside an effect whose deps
  // are [huntId, scanEnabled, scanTick] — so switching language re-rendered
  // every label around it and left this one frozen in the old locale. Reported
  // from a phone: an English screen showing "Inicia sesión para recibir
  // premios." Storing the key and translating at render makes that
  // unrepresentable rather than merely fixed.
  //
  // `message` carries server text, which has no key to translate.
  const [spawnError, setSpawnError] = useState<
    | { key: "signInForSpawns" | "spawnFeedUnreachable" }
    | { message: string }
    | null
  >(null);
  const [selectedSpawnId, setSelectedSpawnId] = useState<string | null>(null);
  const spawnReason = useSpawnReason();
  const tPayout = useTranslations("payout");
  const tGps = useTranslations("gps");
  const tHunt = useTranslations("hunt");
  const tNav = useTranslations("nav");
  const tRefusal = useTranslations("refusal");
  const [collectingId, setCollectingId] = useState<string | null>(null);
  const [collectNote, setCollectNote] = useState<{
    text: string;
    tone: "success" | "warn";
  } | null>(null);
  const [scanTick, setScanTick] = useState(0);

  /* --- Editions ---------------------------------------------------------
     A chance encounter, not a place. Polled on the same tick as the spawn
     scan because the server decides whether one is due — the client cannot
     know, so asking IS the trigger. Everything about where the hunter is
     standing is irrelevant here; see lib/hunt/edition.ts. */
  const [edition, setEdition] = useState<{
    offer: EditionOfferView;
    payTo: string | null;
    alreadyHeld: boolean;
  } | null>(null);

  useEffect(() => {
    if (!huntActive) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`/api/hunt/${huntId}/edition`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const body = (await res.json()) as {
          offered?: boolean;
          payTo?: string | null;
          alreadyHeld?: boolean;
          edition?: EditionOfferView;
        };
        if (body.offered && body.edition) {
          setEdition({
            offer: body.edition,
            payTo: body.payTo ?? null,
            alreadyHeld: body.alreadyHeld ?? false,
          });
        }
      } catch {
        // A missed poll is a non-event: the next tick asks again, and an
        // encounter nobody was shown is simply one that did not happen.
      }
    })();
    return () => controller.abort();
  }, [huntId, huntActive, scanTick]);

  const answerEdition = useCallback(
    async (answer: "yes" | "no", paymentTxHash?: string) => {
      const id = edition?.offer.id;
      // Close on "no" immediately. A dismissal that waits on the network
      // feels broken while a spawn is ticking down behind the card.
      if (answer === "no") setEdition(null);
      if (!id) return { ok: true };
      try {
        const res = await fetch(`/api/hunt/${huntId}/edition/answer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ editionId: id, answer, paymentTxHash }),
        });
        const body = (await res.json()) as { ok?: boolean; reason?: string };
        return { ok: body.ok === true, reason: body.reason };
      } catch {
        return { ok: false, reason: "network" };
      }
    },
    [edition, huntId],
  );

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

  /**
   * Check in before scanning.
   *
   * Spawns anchor to a verified position, and until this ran the scan returned
   * `no_verified_position` forever — the player walked and nothing appeared.
   *
   * ## Why `fix` is a ref and not a dependency
   *
   * It was a dependency, and that broke the feature outdoors. `fix` changes on
   * every GPS update; on a moving phone reporting ±2m that is roughly every
   * second. Each change re-ran the effect, whose cleanup aborted the in-flight
   * check-in — so on exactly the device this is built for, walking, the
   * request never survived long enough to land.
   *
   * The cooldown made it worse rather than papering over it: it was stamped
   * when the request STARTED, so each aborted attempt still burned the full
   * sixty seconds before another was allowed. Reported from the street as
   * "walked a few blocks, nothing spawned", with GPS at ±2m.
   *
   * Now the latest fix is read from a ref at send time, the effect is driven
   * by the tick alone, and only a COMPLETED attempt spends the cooldown.
   */
  const fixRef = useRef(fix);
  useEffect(() => {
    fixRef.current = fix;
  }, [fix]);

  /**
   * Start the moment there is a position, not on the next tick.
   *
   * The check-in above is driven by `scanTick` alone, for the good reason
   * documented there. The cost was a dead first half-minute: on open the
   * effect runs once with no fix and returns, the fix lands two seconds later,
   * and nothing re-runs it until the 30s interval fires. Reported from a
   * phone — the "getting your hunt ready" bar finishes and then the game
   * simply does not start.
   *
   * Depending on a BOOLEAN rather than on `fix` is what makes this safe. It
   * flips once, when the first fix arrives, so it cannot reintroduce the
   * regression that made `fix` a ref: a walking player's ±2m updates leave
   * `hasFix` true and fire nothing. It is a dependency of the check-in effect
   * below rather than a setState here, because a setState in an effect body
   * is a cascading render and the lint rightly refuses it.
   */
  const hasFix = fix !== null;

  const lastCheckInRef = useRef(0);

  useEffect(() => {
    if (!scanEnabled) return;
    const current = fixRef.current;
    if (current === null) return;
    if (Date.now() - lastCheckInRef.current < cooldownSeconds * 1000) return;

    // Deliberately NOT aborted on cleanup. This is a small POST whose whole
    // job is to land; cancelling it because the GPS moved is what broke it.
    // A late reply is simply ignored.
    let ignore = false;
    checkIn(huntId, current)
      .then((r) => {
        if (ignore) return;
        lastCheckInRef.current = Date.now();
        // A refused check-in is worth showing: it is almost always GPS
        // accuracy, which the player can fix by stepping outside.
        if (!r.ok && r.reason) setScanReason(r.reason);
        // Scan NOW rather than at the next 30s tick. Until the check-in lands
        // the scan can only answer `no_verified_position`, so the first useful
        // scan is this one — waiting for the interval is the other half of the
        // dead first half-minute. Safe from looping: this re-runs the effect,
        // but the cooldown guard above has just been stamped, so it returns.
        setScanTick((n) => n + 1);
      })
      .catch(() => {
        // Leave the cooldown unspent so the next tick retries promptly.
      });
    return () => {
      ignore = true;
    };
  }, [scanEnabled, huntId, cooldownSeconds, scanTick, hasFix]);

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
          setSpawnError({ key: "signInForSpawns" });
          return;
        }
        // A 429 here is self-inflicted only if something else is scanning; back
        // off rather than hammering a money-path limiter.
        if (e instanceof ApiError && e.status === 429) return;
        setSpawnError(
          e instanceof ApiError
            ? { message: e.message }
            : { key: "spawnFeedUnreachable" },
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

  const gate = useClaimGate({
    fix,
    maxAccuracyM,
    phase,
    cooldownSecondsLeft,
    complete: hint.complete,
    cacheless: hint.cacheless,
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
    // and a button that says "checking" through a passkey sheet reads as a hang.
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
            : tHunt("claimNotSentBody"),
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
          const amount = formatMon(weiOrZero(result.amountMonWei));
          setCollectNote(
            result.payout.holdReason === null
              ? { text: tPayout("released", { amount }), tone: "success" }
              : {
                  text: tPayout("held", {
                    amount,
                    reason: result.payout.holdReason,
                  }),
                  tone: "warn",
                },
          );
        } else {
          setSpawnError({ message: spawnReason(result.reason) });
        }
      } catch (e: unknown) {
        // Resolved here rather than keyed, and that is fine: these are set by
        // a deliberate tap and cleared by the next scan, so they cannot sit on
        // screen across a language switch. The 401 above can — it also sets
        // scanStopped, so the effect never runs again to replace it — which is
        // why that one, and only that one, has to carry a key.
        setSpawnError({
          message:
            e instanceof SignerMissingError
              ? tPayout("signerMissing")
              : e instanceof ApiError
                ? e.message
                : tPayout("failed"),
        });
      } finally {
        setCollectingId(null);
        setScanTick((n) => n + 1);
      }
    },
    [fix, huntId, signer],
  );

  // The claim toast is a notification, not a permanent panel: show it, let the
  // player read the amount, then clear it. Held payouts linger a little longer
  // because they carry a reason worth reading.
  useEffect(() => {
    if (collectNote === null) return;
    const id = window.setTimeout(
      () => setCollectNote(null),
      collectNote.tone === "success" ? 6_000 : 9_000,
    );
    return () => window.clearTimeout(id);
  }, [collectNote]);

  // A refusal is transient. Leaving it on screen makes the player think it
  // still applies after they have walked somewhere else.
  useEffect(() => {
    if (refusal === null) return;
    const id = window.setTimeout(() => setRefusal(null), 12_000);
    return () => window.clearTimeout(id);
  }, [refusal]);

  const refusalText =
    refusal === null
      ? null
      : {
          title: tRefusal(`${refusal}.title`),
          body: tRefusal(`${refusal}.body`),
        };

  return (
    /* -----------------------------------------------------------------------
       An app shell, not a document.

       Measured on the live screen at 375px: 1054px of content against 629px of
       viewport. Every phone scrolled — the worst offender being the scope,
       which is a square sized to the viewport WIDTH, so a bigger phone made
       the page taller rather than roomier. The claim button, the one control
       that moves money, sat below the fold on every device.

       So the page is now exactly one viewport and never scrolls. Three things
       are pinned — the header, the scope and the claim button — and everything
       whose height depends on the world (the GPS notes, the spawn list, the
       band readout, refusals) lives in a single flexible region that scrolls
       on its own. That fits by construction at any size instead of by an
       arithmetic that the next panel breaks.

       Floor is 360x740. The scope stays the hero at full width there.
    ----------------------------------------------------------------------- */
    <main className="safe-top safe-bottom mx-auto flex h-dvh w-full max-w-md flex-col gap-3 overflow-hidden px-4">
      <header className="flex shrink-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-ink truncate text-lg font-semibold">
            {hunt?.name ?? tHunt("titleFallback")}
          </h1>
          <p className="text-ink-faint font-mono text-[11px] tracking-[0.16em] uppercase">
            {huntActive ? tHunt("live") : tHunt("closed")} ·{" "}
            {compass.heading === null ? tHunt("northUp") : tHunt("headingUp")}
          </p>
        </div>
        {/* The wallet link alone. The language pill was tried here and the
            header could not afford it: at 360px it crushed the hunt name to
            "Bús..." and wrapped the status onto three lines, costing 25px to
            save 30. It lives at the foot of the scroller instead, where the
            flexible region absorbs it for nothing. */}
        <Link
          href="/hunt/wallet"
          className="border-hull-line text-ink-dim flex min-h-11 shrink-0 items-center rounded-xl border px-3 font-mono text-xs tracking-widest uppercase"
        >
          {tNav("wallet")}
        </Link>
      </header>

      {/* The hero, and still full width on the 360x740 floor: 46dvh is 340px
          there against the 328px the column gives it, so the cap does not
          bind. It binds on something shorter — a small phone in landscape, a
          split view — where a width-square scope would otherwise take the
          whole screen and push the claim button out. */}
      <div className="mx-auto w-full max-w-[min(100%,46dvh)] shrink-0">
        <RadarScope
          headingDeg={compass.heading}
          band={hint.band}
          complete={hint.complete}
          rangeMeters={rangeMeters}
          fix={fix}
          spawns={marks}
          selectedSpawnId={selectedSpawnId}
          onSelectSpawn={setSelectedSpawnId}
          now={now}
        />
      </div>

      {/* The one scrolling region. Everything in here can grow without
          pushing the claim button off the screen. */}
      <div className="relative min-h-0 flex-1 space-y-3 overflow-y-auto">
        {/* Offered whenever there is no heading and the player has not refused.
          Safe on every platform: on iOS it opens the permission prompt, and
          elsewhere it re-subscribes, which is what some Androids need before
          the absolute event starts arriving at all. */}
        {compass.heading === null && !compass.denied ? (
          <button
            onClick={compass.request}
            className="border-hull-line text-ink bg-hull min-h-12 w-full rounded-2xl border-2 px-4 text-sm font-semibold"
          >
            {tGps("compass")}
          </button>
        ) : null}

        {/* Directly under the scope, and above everything else, because these two
          are what explain a dish that looks dead. Buried below the fold — which
          is where they were — a player waiting on a GPS lock sees a black
          circle and concludes the app is broken. Reported from the street. */}
        <FixReadout
          fix={fix}
          status={geo.status}
          // The hook's own MESSAGES map stays English: lib/ has non-UI callers and
          // a status string is data. Only what reaches the screen is translated,
          // and only when the hook had something to say at all.
          message={geo.message === null ? null : tGps(geo.status)}
          maxAccuracyM={maxAccuracyM}
          now={now}
          since={geo.since}
          onRetry={geo.retry}
        />

        <SpawnPanel
          marks={marks}
          now={now}
          selectedId={selectedSpawnId}
          onSelect={setSelectedSpawnId}
          onCollect={(id) => void onCollect(id)}
          collectingId={collectingId}
          scanReason={scanReason}
          stopped={scanStopped}
          error={
            spawnError === null
              ? null
              : "key" in spawnError
                ? tHunt(spawnError.key)
                : spawnError.message
          }
          signingAvailable={signer !== null}
        />

        <BandReadout
          band={hint.band}
          complete={hint.complete}
          cacheless={hint.cacheless}
          remaining={hint.remaining}
          status={hint.status}
          error={hint.error}
        />

        {refusalText ? (
          <Note tone="warn" title={refusalText.title}>
            {refusalText.body}
          </Note>
        ) : null}

        {claimError ? (
          <Note tone="warn" title={tHunt("claimNotSentTitle")}>
            {claimError}
          </Note>
        ) : null}

        <LanguageSwitch className="flex justify-end pb-1" />
      </div>

      {/* Pinned to the bottom of the viewport, outside the scroller.
          This is the only control that moves money, and it was previously
          below the fold on every phone measured — reachable only by scrolling
          past the spawn list, which grows exactly when claiming matters most. */}
      <div className="shrink-0 pb-1">
        <ClaimButton gate={gate} onClaim={() => void onClaim()} />
      </div>

      {/* The encounter. Sits above the scope and below the collect toast, so
          a payout confirmation is never hidden by a sales pitch. */}
      {edition ? (
        <EditionCard
          offer={edition.offer}
          payTo={edition.payTo}
          alreadyHeld={edition.alreadyHeld}
          onAnswer={answerEdition}
          pay={payFromPasskey}
        />
      ) : null}

      {/* A claim confirmation must POP UP where the player is looking — pinned to
          the top of the viewport, not buried at the bottom of the scroll where
          the collect result used to render. Auto-dismisses; see the effect. */}
      {collectNote ? (
        <div
          role="status"
          aria-live="polite"
          className="fixed left-1/2 top-4 z-50 w-[calc(100%-1.5rem)] max-w-md -translate-x-1/2"
        >
          <div
            className={`rounded-2xl border-l-4 p-4 shadow-2xl backdrop-blur ${
              collectNote.tone === "success"
                ? "border-spawn bg-hull-2/95"
                : "border-band-hot bg-hull-2/95"
            }`}
          >
            <div
              className={`font-mono text-xs tracking-[0.16em] uppercase ${
                collectNote.tone === "success" ? "text-spawn" : "text-band-hot"
              }`}
            >
              {collectNote.tone === "success"
                ? tPayout("claimed")
                : tPayout("title")}
            </div>
            <div className="text-ink mt-1 text-base leading-snug font-semibold">
              {collectNote.text}
            </div>
          </div>
        </div>
      ) : null}

      {/* Credit, not payment. Somebody walked this ground and judged it safe
          to send strangers down, which is local knowledge no import produces.
          Naming them costs nothing and cannot be farmed — unlike a reward per
          area surveyed, which would pay people to mark the highway walkable. */}
      {hunt?.surveyors && hunt.surveyors.length > 0 ? (
        <Note title={tHunt("surveyedBy")}>
          {hunt.surveyors.map((s) => s.displayName).join(", ")}
        </Note>
      ) : null}

      {huntMissing ? (
        <Note title={tHunt("detailsUnavailableTitle")}>
          {tHunt("detailsUnavailableBody", {
            huntId,
            accuracy: FALLBACK_HUNT.maxAccuracyM,
            cooldown: FALLBACK_HUNT.cooldownSeconds,
          })}
        </Note>
      ) : null}

      {signer === null ? (
        <p className="text-ink-faint px-1 text-center text-xs leading-snug">
          {tHunt("unsignedBuild")}
        </p>
      ) : null}

      {find ? <FindReveal find={find} onDismiss={() => setFind(null)} /> : null}
    </main>
  );
}
