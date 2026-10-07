import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __setAudioContextFactory,
  isMuted,
  isMutedOnServer,
  playChime,
  setMuted,
  subscribeMuted,
  unlockAudio,
} from "./chime";

type FakeNode = { connect: (n: unknown) => unknown };

function fakeContext(state: AudioContextState = "running") {
  const started: number[] = [];
  const freqs: number[] = [];
  const resume = vi.fn(() => Promise.resolve());
  const ctx = {
    currentTime: 0,
    get state() {
      return state;
    },
    resume,
    createOscillator: () => {
      const osc = {
        type: "",
        frequency: { setValueAtTime: (f: number) => freqs.push(f) },
        connect: (n: unknown) => n as FakeNode,
        start: (t: number) => started.push(t),
        stop: () => {},
      };
      return osc;
    },
    createGain: () => ({
      gain: {
        setValueAtTime: () => {},
        exponentialRampToValueAtTime: () => {},
      },
      connect: (n: unknown) => n as FakeNode,
    }),
    destination: {},
  };
  return { ctx, started, freqs, resume };
}

// This suite runs in node, which has no localStorage. The module copes with
// that (and with Safari private mode, where touching it throws); the mute
// tests need a real one to set.
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  __setAudioContextFactory(null);
});

describe("playChime", () => {
  it("plays a three-note triad when the payout was released", () => {
    const f = fakeContext();
    __setAudioContextFactory(() => f.ctx as unknown as AudioContext);
    playChime("success");
    expect(f.started).toHaveLength(3);
    expect(f.freqs).toEqual([880.0, 1108.7, 1318.5]);
  });

  it("plays something shorter and lower when the payout is held", () => {
    // Collected, but the money has not moved. Celebrating it would be a lie
    // the player can hear.
    const f = fakeContext();
    __setAudioContextFactory(() => f.ctx as unknown as AudioContext);
    playChime("held");
    expect(f.started).toHaveLength(2);
    expect(Math.max(...f.freqs)).toBeLessThan(880.0);
  });

  it("stays silent when the player has muted it", () => {
    const f = fakeContext();
    __setAudioContextFactory(() => f.ctx as unknown as AudioContext);
    globalThis.localStorage.setItem("hunt.sound", "off");
    playChime("success");
    expect(f.started).toHaveLength(0);
  });

  it("never throws when there is no audio at all", () => {
    // A phone that will not make noise must not cost the player their collect.
    __setAudioContextFactory(() => null);
    expect(() => playChime("success")).not.toThrow();
    expect(() => unlockAudio()).not.toThrow();
  });

  it("never throws when the context refuses mid-flight", () => {
    __setAudioContextFactory(() => {
      throw new Error("AudioContext closed");
    });
    expect(() => playChime("success")).not.toThrow();
    expect(() => unlockAudio()).not.toThrow();
  });
});

describe("unlockAudio", () => {
  it("resumes a suspended context, which is the whole iOS story", () => {
    // Without this the chime is silent on iOS forever: the context may only be
    // resumed from inside the gesture, and the collect answer arrives later.
    const f = fakeContext("suspended");
    __setAudioContextFactory(() => f.ctx as unknown as AudioContext);
    unlockAudio();
    expect(f.resume).toHaveBeenCalledTimes(1);
  });

  it("does not resume one that is already running", () => {
    const f = fakeContext("running");
    __setAudioContextFactory(() => f.ctx as unknown as AudioContext);
    unlockAudio();
    expect(f.resume).not.toHaveBeenCalled();
  });

  it("stays silent when muted rather than resuming audio nobody asked for", () => {
    const f = fakeContext("suspended");
    __setAudioContextFactory(() => f.ctx as unknown as AudioContext);
    globalThis.localStorage.setItem("hunt.sound", "off");
    unlockAudio();
    expect(f.resume).not.toHaveBeenCalled();
  });
});

const HUNT_SCREEN = readFileSync(
  new URL("../../app/hunt/[huntId]/HuntScreen.tsx", import.meta.url),
  "utf8",
);

describe("the iOS ordering rule", () => {
  it("unlocks before awaiting, not after", () => {
    // The bug this prevents is silent and only on real iOS: if unlockAudio()
    // moves after the await it still typechecks, still passes every other
    // test here, and simply never makes a sound on a phone.
    const src = HUNT_SCREEN;
    const unlock = src.indexOf(
      "unlockAudio();",
      src.indexOf("const onCollect"),
    );
    const await_ = src.indexOf("await collectSpawn");
    expect(unlock).toBeGreaterThan(-1);
    expect(unlock).toBeLessThan(await_);
  });

  it("picks the tone from whether the payout actually moved", () => {
    // Without this, playChime("success") on every collect passes every other
    // test in this file while telling the player money landed when it is
    // still held. The distinction only exists at the call site.
    expect(HUNT_SCREEN).toContain(
      'playChime(result.payout.holdReason === null ? "success" : "held")',
    );
  });
});

describe("the mute store behind the UI toggle", () => {
  it("round-trips through setMuted", () => {
    expect(isMuted()).toBe(false);
    setMuted(true);
    expect(isMuted()).toBe(true);
    setMuted(false);
    expect(isMuted()).toBe(false);
  });

  it("tells subscribers so the toggle cannot disagree with the sound", () => {
    const seen = vi.fn();
    const stop = subscribeMuted(seen);
    setMuted(true);
    expect(seen).toHaveBeenCalledTimes(1);
    stop();
    setMuted(false);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("reports unmuted on the server, so the markup matches on hydration", () => {
    // The server cannot read this device's localStorage. If the server
    // snapshot guessed, React would warn and the button would flicker.
    setMuted(true);
    expect(isMutedOnServer()).toBe(false);
  });

  it("muting actually silences playChime, not just the label", () => {
    const f = fakeContext();
    __setAudioContextFactory(() => f.ctx as unknown as AudioContext);
    setMuted(true);
    playChime("success");
    expect(f.started).toHaveLength(0);
    setMuted(false);
    playChime("success");
    expect(f.started).toHaveLength(3);
  });

  it("does not throw when localStorage is unavailable", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(() => setMuted(true)).not.toThrow();
    expect(isMuted()).toBe(false);
  });
});

describe("the toggle's translations", () => {
  const load = (f: string) =>
    JSON.parse(
      readFileSync(
        new URL(`../../messages/${f}.json`, import.meta.url),
        "utf8",
      ),
    ) as { sound?: Record<string, string> };

  it("exist in every locale, because a missing key renders the key", () => {
    for (const locale of ["en", "es"]) {
      const sound = load(locale).sound;
      expect(sound, locale).toBeDefined();
      for (const key of ["label", "on", "off"]) {
        expect(sound?.[key], `${locale}.sound.${key}`).toBeTruthy();
      }
    }
  });
});

describe("the spawn alert", () => {
  it("is quieter and lower than the collect chime", () => {
    // It fires every time a drop appears, so it has to be noticeable from a
    // pocket without being an alarm. The collect chime is the celebration;
    // confusing the two would train people to ignore both.
    const sp = fakeContext();
    __setAudioContextFactory(() => sp.ctx as unknown as AudioContext);
    playChime("spawn");
    const spawnFreqs = [...sp.freqs];

    __setAudioContextFactory(null);
    const su = fakeContext();
    __setAudioContextFactory(() => su.ctx as unknown as AudioContext);
    playChime("success");

    expect(Math.max(...spawnFreqs)).toBeLessThan(Math.max(...su.freqs));
    expect(spawnFreqs).toHaveLength(2);
  });

  it("is silenced by the same mute as everything else", () => {
    const f = fakeContext();
    __setAudioContextFactory(() => f.ctx as unknown as AudioContext);
    globalThis.localStorage.setItem("hunt.sound", "off");
    playChime("spawn");
    expect(f.started).toHaveLength(0);
  });
});

describe("the iOS unlock, which the spawn alert depends on", () => {
  const SRC = readFileSync(
    new URL("../../app/hunt/[huntId]/HuntScreen.tsx", import.meta.url),
    "utf8",
  );

  it("unlocks audio on a touch, not only inside collect", () => {
    // A spawn arrives from a poll. iOS will not start an AudioContext outside
    // a gesture, so without a screen-wide unlock the alert is silent on every
    // iPhone until the player collects — which is after they needed telling.
    expect(SRC).toContain('addEventListener("pointerdown"');
    expect(SRC).toContain("unlockAudio");
  });

  it("announces by spawn id, not by how many there are", () => {
    // One expiring as another appears leaves the count at 1 and is still a
    // new drop. A length check would stay silent for it.
    expect(SRC).toContain("announced.current.has");
    expect(SRC).toContain("announced.current.add");
    expect(SRC).toContain('playChime("spawn")');
  });
});

describe("the cache band alert", () => {
  const SRC = readFileSync(
    new URL("../../app/hunt/[huntId]/HuntScreen.tsx", import.meta.url),
    "utf8",
  );

  it("sounds when the band reaches burning", () => {
    // RadarScope draws no cache marker on purpose — a blip at a buried cache
    // would give away the thing the player is meant to find. The instrument
    // turning red IS the signal, and a player walking with the phone down
    // never sees it.
    expect(SRC).toContain('hint.band === "burning"');
    expect(SRC).toContain("wasBurning");
  });

  it("sounds on ENTERING burning, not on every poll inside it", () => {
    // The band is recomputed continuously. Without the edge check this is an
    // alarm that repeats until the player either claims or force-quits.
    expect(SRC).toContain("if (wasBurning.current) return;");
  });

  it("re-arms when the player cools off", () => {
    // Stepping out and back in is a new "you are on it", so the flag has to
    // be cleared rather than latched forever.
    expect(SRC).toContain("wasBurning.current = false;");
  });
});

describe("playChime reports whether it was audible", () => {
  it("returns false on a suspended context, which makes no sound", () => {
    // THE BUG. A suspended context accepts every call silently. Reporting
    // success let the caller mark the moment announced, so the cache alert
    // fired once into the void on page load — before any tap had unlocked
    // audio — and never again while the player stood on the cache.
    const f = fakeContext("suspended");
    __setAudioContextFactory(() => f.ctx as unknown as AudioContext);
    expect(playChime("spawn")).toBe(false);
    expect(f.started).toHaveLength(0);
  });

  it("returns true when it actually schedules notes", () => {
    const f = fakeContext("running");
    __setAudioContextFactory(() => f.ctx as unknown as AudioContext);
    expect(playChime("spawn")).toBe(true);
    expect(f.started.length).toBeGreaterThan(0);
  });

  it("returns false when muted, and when there is no audio at all", () => {
    const f = fakeContext("running");
    __setAudioContextFactory(() => f.ctx as unknown as AudioContext);
    globalThis.localStorage.setItem("hunt.sound", "off");
    expect(playChime("spawn")).toBe(false);
    globalThis.localStorage.removeItem("hunt.sound");
    __setAudioContextFactory(() => null);
    expect(playChime("spawn")).toBe(false);
  });
});

describe("the callers only latch on an audible alert", () => {
  const SRC = readFileSync(
    new URL("../../app/hunt/[huntId]/HuntScreen.tsx", import.meta.url),
    "utf8",
  );

  it("the cache band latches the return value, not true", () => {
    expect(SRC).toContain('wasBurning.current = playChime("spawn")');
  });

  it("the spawn list returns early when nothing was heard", () => {
    expect(SRC).toContain('if (!playChime("spawn")) return;');
  });

  it("both retry on the clock, not only when the value changes", () => {
    // Unlocking happens on a tap, which changes neither hint.band nor the
    // spawn list. Without `now` in the deps the effect never re-runs and the
    // retry never happens.
    expect(SRC).toContain("[hint.band, now]");
    expect(SRC).toContain("[spawns, now]");
  });
});
