"use client";

// Client half of the registration bot check. See lib/auth/captcha.ts for why
// this guards registration and not claiming.
//
// Registration here is not a form the player fills in — it happens inside
// signIn(), triggered by a passkey tap. So the widget is rendered with
// `execution: "execute"` and `appearance: "interaction-only"`, which keeps it
// invisible and silent unless Cloudflare actually decides a human needs to do
// something. A player walking outdoors with one hand on the phone sees nothing
// in the ordinary case; a scripted farm hits a challenge on every identity.
//
// Returns null when NEXT_PUBLIC_TURNSTILE_SITE_KEY is unset, which pairs with
// the server accepting a missing token when TURNSTILE_SECRET_KEY is unset. Both
// halves are inert together or active together; there is no configuration where
// the client sends nothing and the server demands something, except the one
// that matters — server configured, old client — which correctly fails.

const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const SCRIPT_ID = "cf-turnstile-script";
const TIMEOUT_MS = 30_000;

interface TurnstileApi {
  render(
    container: HTMLElement | string,
    opts: {
      sitekey: string;
      callback?: (token: string) => void;
      "error-callback"?: (code?: string) => void;
      "timeout-callback"?: () => void;
      execution?: "render" | "execute";
      appearance?: "always" | "execute" | "interaction-only";
    },
  ): string;
  execute(container: HTMLElement | string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export function captchaSiteKey(): string {
  return process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";
}

let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID);
    const el = (existing as HTMLScriptElement | null) ?? document.createElement("script");
    if (!existing) {
      el.id = SCRIPT_ID;
      el.src = SCRIPT_SRC;
      el.async = true;
      el.defer = true;
      document.head.appendChild(el);
    }
    el.addEventListener("load", () => resolve());
    el.addEventListener("error", () => {
      // Let the next attempt retry rather than caching the failure forever.
      scriptPromise = null;
      reject(new Error("Could not load the bot check."));
    });
    if (window.turnstile) resolve();
  });
  return scriptPromise;
}

/**
 * Obtain a Turnstile token, or null when no site key is configured.
 *
 * Throws when a key IS configured and the challenge cannot be completed — a
 * silent null there would send an empty token to a server that requires one and
 * surface as a confusing 403 instead of "the bot check failed".
 */
export async function getCaptchaToken(): Promise<string | null> {
  const sitekey = captchaSiteKey();
  if (sitekey.length === 0) return null;
  if (typeof window === "undefined") return null;

  await loadScript();
  const api = window.turnstile;
  if (!api) throw new Error("Could not load the bot check.");

  // Positioned rather than display:none — an interaction-only widget must be
  // able to show itself if Cloudflare decides to challenge, and a hidden
  // container would leave the player with an invisible thing to click.
  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.bottom = "1rem";
  container.style.left = "50%";
  container.style.transform = "translateX(-50%)";
  container.style.zIndex = "9999";
  document.body.appendChild(container);

  let widgetId: string | undefined;
  const cleanup = () => {
    try {
      if (widgetId) api.remove(widgetId);
    } catch {
      // Removing an already-removed widget is not worth surfacing.
    }
    container.remove();
  };

  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("The bot check timed out. Try again.")),
        TIMEOUT_MS,
      );
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        fn();
      };

      widgetId = api.render(container, {
        sitekey,
        execution: "execute",
        appearance: "interaction-only",
        callback: (token) => settle(() => resolve(token)),
        "error-callback": () =>
          settle(() => reject(new Error("The bot check failed. Try again."))),
        "timeout-callback": () =>
          settle(() => reject(new Error("The bot check timed out. Try again."))),
      });

      api.execute(container);
    });
  } finally {
    cleanup();
  }
}
