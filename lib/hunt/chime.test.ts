import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __setAudioContextFactory,
  whySilent,
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
  it("is lower than the collect chime, and sounds twice", () => {
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

    // Lower in PITCH, which is what makes it read as a different event. It is
    // deliberately NOT quieter: the first version was, at a third of the
    // chime's gain, and was inaudible on a phone outdoors.
    expect(Math.max(...spawnFreqs)).toBeLessThan(Math.max(...su.freqs));
    expect(spawnFreqs).toHaveLength(4);
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

  it("listens for the unlocking tap APP-WIDE, not on the hunt screen", () => {
    // The gesture that matters is the tap that OPENS a hunt, on the hunt
    // list, before HuntScreen exists. A listener mounted with the hunt screen
    // never sees it, and a player who then just walks never taps again — so
    // the beep stayed silent until they poked the screen, which is the thing
    // they are not doing while looking at the street.
    const PROVIDERS = readFileSync(
      new URL("../../app/providers.tsx", import.meta.url),
      "utf8",
    );
    expect(PROVIDERS).toContain("listenForUnlock()");
    expect(SRC).not.toContain('addEventListener("pointerdown"');
  });

  it("keeps listening until the context is genuinely running", () => {
    // resume() is async, so a tap can land before it takes. Detaching on an
    // unverified resume is how this fails silently.
    const CHIME = readFileSync(new URL("./chime.ts", import.meta.url), "utf8");
    expect(CHIME).toContain("if (whySilent() === null) detach();");
    // The registrations themselves must carry no `once`, which would detach
    // after a tap that did not actually unlock anything. Checked on the call
    // rather than the file, because the comment above it says "once" too.
    expect(CHIME).toContain('addEventListener("pointerdown", attempt);');
    expect(CHIME).toContain('addEventListener("touchend", attempt);');
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

  it("keeps beeping while the player is on the cache", () => {
    // A cache has no marker on the scope, so the sound is not an alert that
    // something happened — it is the instrument the player sweeps with. One
    // beep says a cache is near; the repeat says whether the last step was
    // the right one. Reported as "it should be constant beeping".
    expect(SRC).toContain('playChime("near")');
    expect(SRC).toContain("setInterval(beep, 2_500)");
  });

  it("beeps once immediately, not only after the first interval", () => {
    // Otherwise the player stands on the cache in silence for 2.5 seconds
    // and concludes it is broken, which is where this whole thread started.
    expect(SRC).toContain("beep();\n    const id = window.setInterval");
  });

  it("tears the timer down when the band changes", () => {
    // Scoped to THIS effect, not the file. There is another setInterval in
    // HuntScreen for the spawn scan, so a file-wide search for
    // clearInterval passes even when the beep timer leaks — which it did,
    // and the mutation that should have caught it hit the other one.
    const start = SRC.indexOf('if (hint.band !== "burning") return;');
    expect(start).toBeGreaterThan(-1);
    const effect = SRC.slice(start, SRC.indexOf("}, [hint.band]);", start));
    expect(effect).toContain("window.clearInterval(id)");
    // A leaked timer keeps beeping across the whole city.
    expect(effect).toContain("return () =>");
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
    // Still the return value, just via a named const now that the reason is
    // also recorded. The invariant is that an inaudible attempt does not latch.
    // The spawn list still latches on the return value; the cache band now
    // repeats on a timer instead of latching at all.
    expect(SRC).toContain('if (!playChime("spawn")) return;');
  });

  it("the spawn list returns early when nothing was heard", () => {
    expect(SRC).toContain('if (!playChime("spawn")) return;');
  });

  it("the spawn alert retries on the clock, not only on a list change", () => {
    // Unlocking happens on a tap, which changes neither hint.band nor the
    // spawn list. Without `now` in the deps the effect never re-runs and an
    // alert missed before the first tap is never retried. The cache band no
    // longer needs this — it beeps on its own interval.
    expect(SRC).toContain("[spawns, now]");
  });
});

describe("whySilent names the cause instead of leaving silence ambiguous", () => {
  it("says locked when the context has not been released", () => {
    // The common one, and one tap fixes it. Without a name, a player decides
    // the alert is broken and so does anyone debugging it remotely — which is
    // what happened for four rounds.
    const f = fakeContext("suspended");
    __setAudioContextFactory(() => f.ctx as unknown as AudioContext);
    expect(whySilent()).toBe("locked");
  });

  it("says muted when the player turned it off", () => {
    const f = fakeContext("running");
    __setAudioContextFactory(() => f.ctx as unknown as AudioContext);
    globalThis.localStorage.setItem("hunt.sound", "off");
    expect(whySilent()).toBe("muted");
  });

  it("says no-audio when the browser has none", () => {
    __setAudioContextFactory(() => null);
    expect(whySilent()).toBe("no-audio");
    __setAudioContextFactory(() => {
      throw new Error("blocked");
    });
    expect(whySilent()).toBe("no-audio");
  });

  it("says nothing is wrong when the context is running", () => {
    const f = fakeContext("running");
    __setAudioContextFactory(() => f.ctx as unknown as AudioContext);
    expect(whySilent()).toBeNull();
  });
});

describe("the screen reports a missed alert", () => {
  const SRC = readFileSync(
    new URL("../../app/hunt/[huntId]/HuntScreen.tsx", import.meta.url),
    "utf8",
  );

  it("records why, and offers the tap that fixes it", () => {
    expect(SRC).toContain("setSilence(played ? null : whySilent())");
    expect(SRC).toContain("soundLocked");
  });

  it("shows it only after an alert was actually missed", () => {
    // Starting non-null would nag every player who has simply not been near
    // a cache yet.
    expect(SRC).toContain("useState<SilenceReason>(null)");
  });
});

describe("the beep survives the screen sleeping", () => {
  const SRC = readFileSync(
    new URL("../../app/hunt/[huntId]/HuntScreen.tsx", import.meta.url),
    "utf8",
  );
  const HOOK = readFileSync(
    new URL("../../components/hooks/useScreenAwake.ts", import.meta.url),
    "utf8",
  );

  it("holds the screen awake while hunting", () => {
    // A sleeping screen suspends setInterval and the AudioContext, so the
    // beep stops on its own after a minute or two no matter what the trigger
    // does. Reported as "it beeped for a longer time then it stopped again".
    expect(SRC).toContain("useScreenAwake(scanEnabled && hasFix)");
    expect(HOOK).toContain('request("screen")');
  });

  it("re-acquires the lock after the tab is hidden", () => {
    // The browser releases it on hide and never restores it. Without this,
    // one glance at a message leaves the screen sleeping for the rest of the
    // hunt.
    expect(HOOK).toContain('addEventListener("visibilitychange"');
    expect(HOOK).toContain("void acquire();");
  });

  it("releases it when the player stops hunting", () => {
    // Otherwise the screen stays lit on the hunt list, on a phone that has
    // spent all day in the teens.
    expect(HOOK).toContain("sentinel?.release()");
  });

  it("recovers a suspended context without waiting for a tap", () => {
    // Returning from a locked screen leaves the context suspended, and
    // resuming needs no gesture once the page is visible — so the timer can
    // fix itself instead of the player having to notice.
    const start = SRC.indexOf("const beep = () =>");
    const beep = SRC.slice(start, SRC.indexOf("};", start));
    expect(beep).toContain("unlockAudio()");
    expect(beep.split('playChime("near")').length - 1).toBe(2);
  });
});
