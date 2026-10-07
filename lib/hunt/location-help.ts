/**
 * Which "turn location back on" instructions to show.
 *
 * Needed because a denied permission is a DEAD END, not a retry: once the
 * person has said no, `getCurrentPosition` resolves to the same denial without
 * ever prompting again. Safari on iOS will not re-ask for the life of the site
 * setting. So "enable it in your browser's site settings, then retry" is true
 * and useless — it is the sentence a stranger at an event reads before handing
 * the phone back.
 *
 * The steps are genuinely different per platform, and guessing wrong is worse
 * than saying nothing: sending an iPhone user to a Chrome menu that does not
 * exist reads as the app being broken.
 */

export type LocationPlatform =
  "ios-safari" | "ios-other" | "android-chrome" | "android-other" | "desktop";

/**
 * Best-effort, from the user agent.
 *
 * iOS is checked BEFORE Chrome: every browser on iOS is Safari underneath and
 * reports "CriOS" or "FxiOS" while behaving like Safari, so a Chrome branch
 * tested first would send an iPhone user to an Android menu.
 */
export function detectPlatform(userAgent: string): LocationPlatform {
  const ua = userAgent.toLowerCase();
  const ios =
    /iphone|ipad|ipod/.test(ua) ||
    // iPadOS reports as a Mac; the touch check is what separates them.
    (/macintosh/.test(ua) && /mobile/.test(ua));

  if (ios) {
    // CriOS/FxiOS/EdgiOS are skins over WebKit, but their menus differ, so
    // they are not told to look for Safari's.
    return /crios|fxios|edgios|opios/.test(ua) ? "ios-other" : "ios-safari";
  }
  if (/android/.test(ua)) {
    // Brave and Samsung Internet report "Chrome" too, and their menus are
    // close enough that the same steps work.
    return /chrome|crios|brave|samsungbrowser/.test(ua)
      ? "android-chrome"
      : "android-other";
  }
  return "desktop";
}

/** The i18n key holding the steps for a platform. */
export function helpKey(platform: LocationPlatform): string {
  return `denied_${platform.replace(/-/g, "_")}`;
}
