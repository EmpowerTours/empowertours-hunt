import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectPlatform, helpKey } from "./location-help";

const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36",
  androidBrave:
    "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36 Brave/129",
  androidFirefox:
    "Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
};

describe("detectPlatform", () => {
  it("knows an iPhone in Safari", () => {
    expect(detectPlatform(UA.iphoneSafari)).toBe("ios-safari");
  });

  it("does NOT call Chrome-on-iPhone an Android browser", () => {
    // The trap: CriOS contains "chrome"-adjacent tokens and the UA says
    // Safari too. Testing Android first would send an iPhone user to a menu
    // that does not exist on their phone, which reads as the app being broken.
    expect(detectPlatform(UA.iphoneChrome)).toBe("ios-other");
  });

  it("knows Android Chrome, and Brave which pretends to be it", () => {
    // The user lost at Monad Open was on Brave for Android.
    expect(detectPlatform(UA.androidChrome)).toBe("android-chrome");
    expect(detectPlatform(UA.androidBrave)).toBe("android-chrome");
  });

  it("separates Android Firefox, whose menu differs", () => {
    expect(detectPlatform(UA.androidFirefox)).toBe("android-other");
  });

  it("falls back to desktop rather than guessing", () => {
    expect(detectPlatform(UA.mac)).toBe("desktop");
    expect(detectPlatform("")).toBe("desktop");
  });
});

describe("helpKey", () => {
  it("maps every platform to a key with no dashes", () => {
    for (const ua of Object.values(UA)) {
      const key = helpKey(detectPlatform(ua));
      expect(key.startsWith("denied_")).toBe(true);
      expect(key).not.toContain("-");
    }
  });
});

describe("the strings exist for every platform, in every locale", () => {
  // A missing key renders the key itself. "denied_ios_safari" on screen is
  // worse than the vague sentence this replaced.
  const load = (loc: string) =>
    JSON.parse(
      readFileSync(
        new URL(`../../messages/${loc}.json`, import.meta.url),
        "utf8",
      ),
    ) as { gps: Record<string, string> };

  const platforms = [
    "ios-safari",
    "ios-other",
    "android-chrome",
    "android-other",
    "desktop",
  ] as const;

  it("has steps for each platform in en and es", () => {
    for (const loc of ["en", "es"]) {
      const gps = load(loc).gps;
      for (const p of platforms) {
        const key = helpKey(p);
        expect(gps[key], `${loc}.gps.${key}`).toBeTruthy();
      }
      expect(gps.deniedThenReload, `${loc}.gps.deniedThenReload`).toBeTruthy();
    }
  });

  it("no longer tells the player to just retry, which they cannot", () => {
    // The browser does not prompt again after a denial. The old copy ended
    // "enable it in your browser's site settings, then retry".
    for (const loc of ["en", "es"]) {
      expect(load(loc).gps.denied.toLowerCase()).not.toContain("then retry");
    }
  });
});
