"use client";

/* ---------------------------------------------------------------------------
   Are we inside the EmpowerTours app, or an ordinary browser?

   This matters in exactly one place and it is not cosmetic: inside the app, a
   failed passkey lookup is AMBIGUOUS. It is equally "this phone holds no
   credential" and "this device's credential manager will not serve one to a
   third-party app" — a real failure, measured on a vivo running OriginOS 6,
   where Chrome signs in fine and the app gets NotReadableError in three
   seconds. In a browser the same failure means what it says.

   Two signals because neither alone covers the installed base: MainActivity
   marks the user agent (builds carrying that change), and Capacitor injects a
   global (every build).
--------------------------------------------------------------------------- */
export function inAppWebView(): boolean {
  if (typeof window === "undefined") return false;
  return (
    / EmpowerToursApp\/1 /.test(navigator.userAgent) ||
    typeof (window as { Capacitor?: unknown }).Capacitor !== "undefined"
  );
}
