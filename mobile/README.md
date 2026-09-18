# EmpowerTours for Android

The app, packaged so it can be installed rather than visited.

## One app, two doors

`lib/host.ts` opens with "One app, two public hosts": a single Next.js
deployment serves `hunt.empowertours.xyz` (the game) and
`cota.empowertours.xyz` (the trading floor) off the hostname. They share a
relying-party id and a PRF salt, so they share a passkey and therefore a
**wallet**. Two installs would mean two icons on a phone for one identity and
one balance, so there is one package: `xyz.empowertours.app`.

It opens on Cota, because the Agora bounty asks for a trading app and that is
the trading door. Hunt is reachable in the same WebView (`allowNavigation`).

Names, which are three different fields and not one:

| Where | Value | Limit |
|---|---|---|
| Launcher label (`appName`) | `EmpowerTours` | ~12 chars before most launchers truncate |
| Store title | `EmpowerTours: Hunt & Cota` | 30 (both stores; iOS search cuts ~26) |
| iOS subtitle | `Hunt real caches. Trade Perpl.` | 30 |

## What this is, and what it is not

It is a thin native shell around the **live** origin,
`https://cota.empowertours.xyz`. There is no second copy of the app in here —
no bundled JS, no duplicated routes, nothing to deploy separately and nothing
that can drift out of sync with the web. `www/index.html` is a five-line offline
notice and is the only markup this project owns.

It exists because the Agora Onchain Trading bounty asks for *"a mobile app
authenticating via Mera, holding an AUSD balance, and executing trades through
Perpl"*. Cota does all three today. What it could not do was be installed, and
"open this URL" is a weak answer when the same bounty has entries shipping
native iOS builds.

## Why it points at a URL instead of bundling the app

Ionic's guidance is that `server.url` is for live-reload and not for
production. That is right in general and wrong here, for one specific reason:

**a player's wallet is their passkey.** `lib/auth/derive.ts` turns the PRF
output for `(credential, rpId, salt)` into a BIP-39 seed and then a key. The
credential is scoped to an origin. Run the ceremony under a different origin —
which a bundled build does, because it serves from a local scheme — and the PRF
bytes change, and the player is silently handed a **different wallet with a
different balance**. Keeping the WebView on the real https origin is what makes
one person's wallet one wallet whether they opened Chrome or the app.

The secondary benefits are ordinary: one deploy, one codebase, no release train
between a fix and the phone.

## Digital Asset Links — required, and NOT served from this repo

Android will not let this app use passkeys scoped to `empowertours.xyz` unless
that domain says so first. Without the file, the ceremony fails exactly as it
would for any unrelated app, which is correct and also indistinguishable from
"the app is broken".

Generate the file:

```bash
bash scripts/assetlinks.sh                        # debug keystore
bash scripts/assetlinks.sh path/to/release.jks cota
```

It must be served at:

```
https://empowertours.xyz/.well-known/assetlinks.json
```

**That host is a different application.** `empowertours.xyz` 302s to
`empowertoursxyz-production.up.railway.app`; the hunt and Cota live on
`hunt.` and `cota.` subdomains. The RP id is the parent domain on purpose (see
`PARENT_RP_IDS` in `lib/auth/passkey.ts`) so one passkey works across every
EmpowerTours door — which means the asset-links file has to go up on the parent,
in that other app, not here.

**Do not "fix" this by changing `NEXT_PUBLIC_RP_ID` to a subdomain.** The RP id
is an input to every existing player's wallet derivation. Changing it does not
move their wallet, it replaces it.

Requirements for the file: served over https, `Content-Type: application/json`,
reachable with **no redirect**.

## WebAuthn has to be switched on in the WebView

An Android WebView does not do WebAuthn by default. After `cap add android`,
`MainActivity` needs:

```kotlin
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

// in onCreate, after super.onCreate(savedInstanceState)
if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
    WebSettingsCompat.setWebAuthenticationSupport(
        bridge.webView.settings,
        WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP,
    )
}
```

and `android/app/build.gradle`:

```gradle
implementation "androidx.webkit:webkit:1.14.0"
implementation "androidx.credentials:credentials:1.6.0-beta02"
implementation "androidx.credentials:credentials-play-services-auth:1.6.0-beta02"
```

Two limits worth knowing before debugging a failure:

- The WebKit library does **not** support `mediation: "conditional"`. Nothing in
  `lib/auth/passkey.ts` asks for conditional mediation today; if that changes,
  it changes here too.
- The feature needs a recent system WebView. `isFeatureSupported` is the guard —
  on a device without it, the app should say so rather than opening a ceremony
  that cannot finish.

## Build

`android/` is already generated and committed — do NOT re-run `cap add android`,
it would overwrite the two edits above with nothing in the diff to say why
passkeys stopped working.

Needs the Android SDK, which is not on the dev box this was written on.

```bash
cd mobile
npm install
npx cap sync android
cd android && ./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

## Status

Scaffold, configured, not yet built. No APK exists and nothing has run on a
device, so **the passkey path through the WebView is unproven**. It is also the
only part of this that can fail in a way the web app never does, which makes it
the first thing to test rather than the last.

Ordered, because two of these block the third:

1. Install the Android SDK and produce a debug APK.
2. Publish `assetlinks.json` on `empowertours.xyz` (see above) — without it the
   ceremony cannot succeed no matter how correct the app is.
3. Install on a real Android phone and complete one passkey sign-in, then check
   the wallet address matches the one the same passkey produces in Chrome. If
   those two differ, stop: something about the origin is wrong and shipping it
   would strand balances.
