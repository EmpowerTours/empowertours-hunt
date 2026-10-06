import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setAudioContextFactory, playChime, unlockAudio } from "./chime";

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
