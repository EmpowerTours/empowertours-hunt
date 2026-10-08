/**
 * The sound a collect makes.
 *
 * Synthesised rather than shipped: three short notes cost nothing in the
 * bundle and need no fetch at the moment they have to be instant. An audio
 * file would be a second request on a connection that is, by the nature of
 * this game, a phone outdoors on mobile data — so the first collect of a
 * session could fire while the file was still arriving, or never arrive.
 * Synthesised, the sound is already in the JS that drew the button.
 *
 * To be clear, since the earlier wording here suggested otherwise: NOTHING in
 * Hunt works offline. `collectSpawn` is a signed POST, the server verifies the
 * position, and the payout is a Monad transaction. There IS a web manifest
 * (app/manifest.ts), so Hunt installs to the home screen and looks like a
 * native app — which is exactly what misleads people here. Installable is not
 * offline: that needs a service worker, and there is none. Only the chime
 * needs no network, and only because it is computed rather than downloaded.
 *
 * iOS is the constraint. An AudioContext starts `suspended` and may only be
 * resumed from inside a user gesture, and a collect is a network round trip —
 * by the time the server answers we are long outside the tap that started it.
 * So the two halves are separate on purpose: call `unlockAudio()` synchronously
 * in the tap handler, before any `await`, and `playChime()` whenever the answer
 * arrives. A context resumed during the gesture stays usable afterwards.
 *
 * Everything here fails silently. A phone that will not make noise is not a
 * reason to lose the player's collect.
 */

type Tone = "success" | "held" | "spawn" | "near";

/** Opt out with `localStorage.setItem("hunt.sound", "off")`. */
const MUTE_KEY = "hunt.sound";

type ContextFactory = () => AudioContext | null;

let cached: AudioContext | null = null;
let factory: ContextFactory = () => {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  cached ??= new Ctor();
  return cached;
};

function muted(): boolean {
  try {
    return globalThis.localStorage?.getItem(MUTE_KEY) === "off";
  } catch {
    // Safari in private mode throws on localStorage. Not a reason to be silent.
    return false;
  }
}

// --- the mute setting, as an external store -------------------------------
//
// Exposed this way so the UI toggle can read it through useSyncExternalStore
// and never disagree with what playChime() will actually do. Reading
// localStorage during render would hydration-mismatch, because the server has
// no idea what this device prefers.

const listeners = new Set<() => void>();

/** Subscribe to mute changes, including from another tab. */
export function subscribeMuted(onChange: () => void): () => void {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === MUTE_KEY || e.key === null) onChange();
  };
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

export function isMuted(): boolean {
  return muted();
}

/** The server cannot know; assume sound is on so the markup is stable. */
export function isMutedOnServer(): boolean {
  return false;
}

export function setMuted(next: boolean): void {
  try {
    if (next) globalThis.localStorage?.setItem(MUTE_KEY, "off");
    else globalThis.localStorage?.removeItem(MUTE_KEY);
  } catch {
    // Private mode. The toggle will not persist, which is better than throwing
    // inside a click handler.
  }
  for (const l of listeners) l();
}

function context(): AudioContext | null {
  if (muted()) return null;
  try {
    return factory();
  } catch {
    return null;
  }
}

/**
 * Call from inside the tap, before awaiting anything. Without this the chime
 * is silent on iOS no matter what `playChime` does later.
 */
export function unlockAudio(): void {
  const ctx = context();
  if (ctx === null) return;
  try {
    // THE SILENT SWITCH. On iPhone, Web Audio obeys the hardware Ring/Silent
    // toggle, so every sound here is inaudible on a phone set to silent —
    // which, at an event, is every phone. There is no way to read the switch
    // and nothing in the page looks wrong, so this presents as "the sound
    // feature does not work".
    //
    // Safari 16.4+ exposes an audio session. Declaring "playback" says this is
    // content the user asked for rather than an incidental beep, and iOS then
    // plays it through the silent switch. Wrapped because it exists nowhere
    // else and must never break the unlock on a browser that lacks it.
    const session = (
      navigator as unknown as { audioSession?: { type: string } }
    ).audioSession;
    if (session) session.type = "playback";
  } catch {
    // Older Safari, or a browser that defines it read-only. Sound still works
    // with the ringer on.
  }
  try {
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  } catch {
    // Nothing to recover: the player simply gets no sound.
  }
}

/** One note, shaped so it reads as a chime rather than a beep. */
function note(
  ctx: AudioContext,
  freq: number,
  startAt: number,
  seconds: number,
  peak: number,
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  // Triangle, not sine: a little harmonic content survives a phone speaker,
  // which rolls off the fundamental badly at these frequencies.
  osc.type = "triangle";
  osc.frequency.setValueAtTime(freq, startAt);
  // A fast attack and an exponential tail. Ramping to a true zero is invalid
  // for exponential ramps, hence the epsilon.
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + seconds);
  osc.connect(gain).connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + seconds + 0.02);
}

/**
 * `success` — the payout was released: a rising major triad, the "it landed"
 * sound. `held` — collected, but the payout is held, so it resolves lower and
 * stops short rather than celebrating something that has not happened yet.
 * `spawn` — a drop has appeared: two quiet low notes, meant to be heard from
 * a pocket without making anybody jump.
 *
 * `near` — still on the cache: one pair, repeated by the caller on a timer.
 *
 * RETURNS whether a sound was actually scheduled. False means muted, no audio,
 * or a context iOS has not released yet — and a caller that latches "already
 * announced" on a false has just thrown the announcement away.
 */
export function playChime(tone: Tone): boolean {
  const ctx = context();
  if (ctx === null) return false;
  // A SUSPENDED context accepts every call and makes no sound. Reporting that
  // as success is what broke the cache alert: the caller marked the moment as
  // announced, the player heard nothing, and it never fired again because the
  // moment had already "happened". The caller needs to know, so it can try
  // again on the next reading once a tap has unlocked audio.
  if (ctx.state !== "running") return false;
  try {
    const t = ctx.currentTime;
    if (tone === "success") {
      // A5, C#6, E6 — a major triad arpeggiated fast enough to read as one
      // event rather than three notes.
      note(ctx, 880.0, t, 0.11, 0.18);
      note(ctx, 1108.7, t + 0.055, 0.11, 0.16);
      note(ctx, 1318.5, t + 0.11, 0.22, 0.2);
    } else if (tone === "spawn") {
      // A drop has appeared and the player may be looking at the street
      // rather than the screen. Deliberately NOT an alarm: two low notes a
      // perfect fifth apart, quiet, with a slow decay — noticeable in a
      // pocket, not startling in a cafe, and nothing like the collect chime
      // so the two are never confused. This one repeats as often as spawns
      // do, which is the whole reason it is gentle.
      // LOUD ENOUGH TO HEAR OUTDOORS. The first version ran at 0.09 and 0.07
      // peak against the collect chime's 0.20, chasing "mellow, not
      // annoying" — and mellow turned into inaudible on a phone speaker in a
      // pocket at an event. Reported as no sound at all, which it effectively
      // was. Mellow is the TIMBRE: low notes, slow decay, no sharp attack.
      // Volume is not what makes an alert annoying, repetition is, and that
      // is handled by only firing on the edge.
      //
      // Twice, with a gap, because one short sound outdoors is missable and a
      // pair reads as deliberate rather than as a stray noise.
      note(ctx, 392.0, t, 0.34, 0.26);
      note(ctx, 587.3, t + 0.18, 0.46, 0.22);
      note(ctx, 392.0, t + 0.66, 0.34, 0.24);
      note(ctx, 587.3, t + 0.84, 0.5, 0.2);
    } else if (tone === "near") {
      // The repeat, while standing in the burning band. ONE pair, not two:
      // this fires every few seconds until the cache is claimed or the player
      // walks off, and the four-note version at that cadence is a car alarm.
      // Same two pitches as `spawn`, so it reads as the same event
      // continuing rather than as a second, different thing.
      note(ctx, 392.0, t, 0.3, 0.24);
      note(ctx, 587.3, t + 0.17, 0.4, 0.2);
    } else {
      note(ctx, 660.0, t, 0.14, 0.13);
      note(ctx, 740.0, t + 0.07, 0.16, 0.1);
    }
    return true;
  } catch {
    // An AudioContext can be closed or refused mid-flight. Silence is fine.
    return false;
  }
}

/** Test seam. Never called from application code. */
export function __setAudioContextFactory(f: ContextFactory | null): void {
  cached = null;
  factory =
    f ??
    (() => {
      if (typeof window === "undefined") return null;
      const Ctor = window.AudioContext;
      if (!Ctor) return null;
      cached ??= new Ctor();
      return cached;
    });
}

/**
 * Why the last sound did not play, or null if it did.
 *
 * Exposed because silence is indistinguishable from a broken feature. A
 * player hears nothing and concludes the alert does not work; the operator
 * hears nothing and starts rewriting the trigger. Neither can see that the
 * context is suspended, which is the usual answer and is fixed by one tap.
 */
export type SilenceReason = "muted" | "no-audio" | "locked" | null;

export function whySilent(): SilenceReason {
  if (muted()) return "muted";
  let ctx: AudioContext | null;
  try {
    ctx = factory();
  } catch {
    return "no-audio";
  }
  if (ctx === null) return "no-audio";
  return ctx.state === "running" ? null : "locked";
}
