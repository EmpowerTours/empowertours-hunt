import type { CapacitorConfig } from "@capacitor/cli";

// ---------------------------------------------------------------------------
// EmpowerTours, as an Android app.
//
// ONE app, because there is one app. lib/host.ts: "One app, two public hosts" —
// hunt.empowertours.xyz is the game, cota.empowertours.xyz is the trading
// floor, and a single Next.js deployment serves both off the hostname. They
// share a relying-party id and a PRF salt, so they share a passkey and
// therefore a WALLET. Shipping them as two installs would put two icons on a
// phone for one identity and one balance.
//
// It opens on Cota because the Agora bounty asks for "a mobile app
// authenticating via Mera, holding an AUSD balance, and executing trades
// through Perpl", and that is the trading door. Hunt is reachable from inside
// the same WebView — see allowNavigation.
//
// WHY server.url AND NOT A BUNDLED BUILD
//
// Ionic's own position is that `server.url` is for live-reload and not for
// production, and that is sound advice for an ordinary app. It is the wrong
// advice here, for a reason specific to how this wallet exists at all.
//
// A player's wallet IS their passkey: the PRF output for (credential, rpId,
// salt) is fed through BIP-39 to a key (lib/auth/derive.ts). Change the origin
// the ceremony runs under and you change the credential, which changes the PRF
// bytes, which silently hands them a DIFFERENT wallet with a different balance.
// A bundled build runs on a local scheme, which is a different origin. Pointing
// the WebView at the live https origin is what keeps one person's wallet one
// wallet whether they opened Chrome or the app.
//
// It also means there is no second copy of the app to drift out of sync, no
// second deploy to forget, and nothing here that can disagree with the web.
// ---------------------------------------------------------------------------

const config: CapacitorConfig = {
  // Neutral, because this is ONE app for both doors. `xyz.empowertours.mobile`
  // is already taken by EmpowerTours Radio on the same Apple team, so it is not
  // available and would collide.
  appId: "xyz.empowertours.app",
  // The launcher label, which is a different field from the store title. 12
  // characters, which most launchers render without truncating; the store
  // listing carries "EmpowerTours: Hunt & Cota" (25 of the 30 allowed).
  appName: "EmpowerTours",
  // Capacitor requires a webDir even when the server takes over; www/ holds a
  // shell that is only ever seen if the device is offline before first paint.
  webDir: "www",
  android: {
    // Never ship a debuggable WebView: it exposes the page — and the signing
    // ceremony running in it — to anything with adb on the device.
    webContentsDebuggingEnabled: false,
  },
  server: {
    url: "https://cota.empowertours.xyz",
    // The RP id is empowertours.xyz (the parent, shared across hunt/cota/turbo
    // — see lib/auth/passkey.ts PARENT_RP_IDS), and cota is a registrable
    // subdomain of it, so the same passkey resolves here.
    hostname: "cota.empowertours.xyz",
    // https, not the default capacitor:// scheme. WebAuthn and WebCrypto both
    // require a secure context, and a custom scheme is not one.
    androidScheme: "https",
    // No plaintext, ever. The passkey ceremony and the session cookie both
    // travel over this.
    cleartext: false,
    allowNavigation: [
      "cota.empowertours.xyz",
      "hunt.empowertours.xyz",
      "empowertours.xyz",
    ],
  },
};

export default config;
