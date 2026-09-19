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

| Where                      | Value                            | Limit                                    |
| -------------------------- | -------------------------------- | ---------------------------------------- |
| Launcher label (`appName`) | `EmpowerTours`                   | ~12 chars before most launchers truncate |
| Store title                | `EmpowerTours: Hunt & Cota`      | 30 (both stores; iOS search cuts ~26)    |
| iOS subtitle               | `Hunt real caches. Trade Perpl.` | 30                                       |

## What this is, and what it is not

It is a thin native shell around the **live** origin,
`https://cota.empowertours.xyz`. There is no second copy of the app in here —
no bundled JS, no duplicated routes, nothing to deploy separately and nothing
that can drift out of sync with the web. `www/index.html` is a five-line offline
notice and is the only markup this project owns.

It exists because the Agora Onchain Trading bounty asks for _"a mobile app
authenticating via Mera, holding an AUSD balance, and executing trades through
Perpl"_. Cota does all three today. What it could not do was be installed, and
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

## iOS

Added 2026-09-18. Same shape as Android and for the same reason: a thin shell on
the LIVE origin, because the wallet is the passkey and a bundled build runs on a
different origin.

**WKWebView refuses WebAuthn outright** unless the app declares an Associated
Domain for the relying-party id. That is the exact counterpart of Digital Asset
Links, with the same failure mode — the app installs, opens, renders the real
site, and cannot sign in. `mobile/ios/App/App/App.entitlements` declares
`webcredentials:` for `empowertours.xyz` plus the hunt and cota subdomains.

**The site half is `apple-app-site-association`**, and like assetlinks.json the
copy that counts is on the **apex**, which is a different application on
LiteSpeed/cPanel:

```
https://empowertours.xyz/.well-known/apple-app-site-association
```

Contents (Team `VYPJ7L4YTB`):

```json
{ "webcredentials": { "apps": ["VYPJ7L4YTB.xyz.empowertours.app"] } }
```

Two traps, both of which produce a file that looks fine in a browser and is
rejected by Apple:

- **No file extension**, by Apple's rule — so a server cannot guess its type.
  Apple requires `application/json`. This repo sets that header explicitly in
  `next.config.ts` for the hunt and cota copies; on cPanel the apex copy needs
  a `.htaccess` in `.well-known/`:

  ```apache
  <Files "apple-app-site-association">
    ForceType application/json
  </Files>
  ```

- **No redirects.** Same rule as Digital Asset Links, and the same reason the
  apex works at all: `/.well-known/` escapes the 302 that sends everything else
  to another app.

**Builds run on Codemagic** (`codemagic.yaml` at the repo root), because there is
no Mac here — the Mac Mini runs Ubuntu, so there is no Xcode and no Keychain
anywhere in this project. The root is also the one place Codemagic reads its
config from, and conveniently not `.github/workflows`, which this account's
token cannot write.

**Capacitor 8 uses Swift Package Manager, not CocoaPods.** There is no Podfile
and no `.xcworkspace`. Every Codemagic sample for Ionic says `pod install` and
`--workspace`; both are wrong here, and the build script uses `--project`
against `App.xcodeproj`.

Before the first build, three things must exist, none of them code:

1. App ID `xyz.empowertours.app` registered in the Developer portal **with the
   Associated Domains capability enabled** — without it the entitlement is
   rejected at signing. (`xyz.empowertours.mobile` is EmpowerTours Radio, a
   different app.)
2. An App Store Connect API key connected to Codemagic, named in
   `integrations.app_store_connect`.
3. The AASA file live at the apex.

`TARGETED_DEVICE_FAMILY` is `1` (iPhone only) deliberately: iPad support makes
iPad screenshots mandatory in App Store Connect and there are none at valid iPad
sizes. `ITSAppUsesNonExemptEncryption` is `false` — HTTPS-only use is exempt, and
without the key App Store Connect asks the export-compliance question on every
upload.

**Until an IPA ships, the iPhone route that works today is Safari → Share → Add
to Home Screen.** Passkeys and the PRF extension both work in Safari 18+ with
iCloud Keychain, which is the same wallet the app would derive. Two known iOS
limits, neither of which affects this: extension data is not passed to external
security keys, and PRF does not survive the cross-device QR flow.

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

## Status — APK builds

`./gradlew assembleDebug` produces a 5.2 MB `app-debug.apk`. Verified rather
than assumed:

- `aapt2 dump badging` → `package: xyz.empowertours.app`,
  `application-label: EmpowerTours`, `targetSdkVersion: 36`.
- The dex genuinely contains `setWebAuthenticationSupport` and
  `WEB_AUTHENTICATION_SUPPORT_FOR_APP`, so the WebAuthn enablement compiled in
  rather than being quietly stripped.
- Signed by the Android debug key, SHA-256
  `0C:B0:E8:…:6A:6B`, which is the fingerprint in the asset-links file below.

The debug key is the well-known one every Android SDK generates. That is fine
for sideloading and for judging; a Play release needs its own key, and its
fingerprint gets **added** to the `sha256_cert_fingerprints` array rather than
replacing this one, so debug and release builds both keep working.

### What is still unproven

**Passkey sign-in inside the WebView is VERIFIED ON HARDWARE (2026-09-18).** Both
steps below were carried out: the asset-links file is live and Google's own
`digitalassetlinks.googleapis.com/v1/statements:list` resolves our package and
fingerprint, and on a Xiaomi (HyperOS) the app signed in and produced **the same
wallet address as Chrome on that phone**. One person, one passkey, one wallet,
whichever door they open.

**It does NOT work on every Android.** On a vivo V2348 (Android 16, WebView
Chrome 151) the system credential sheet opens and never resolves. That was run
to ground rather than guessed at: `/diag`'s passkey probe shows a discoverable
`get()` timing out identically **with and without** the PRF extension, which
rules out PRF and rules out the request's contents. Asset links verify, the
WebView reports WebAuthn enabled, the file loads instantly in that phone's own
browser. The device's credential provider simply does not answer a sideloaded
app. Nothing in this repo fixes that — send such a phone to `/diag`, and to Play
Store updates for Google Play services.

The historical note below is kept because it explains why the order matters:
it could not have succeeded before the asset-links file was live, so testing it
earlier would only have proved that a missing file is missing.

1. Publish `assetlinks.json` at
   `https://empowertours.xyz/.well-known/assetlinks.json`. That host is
   **LiteSpeed/cPanel, not Railway** — the apex 302s everything to a different
   app, but `/.well-known/` is NOT caught by that rule (it 404s directly), so a
   file dropped in `public_html/.well-known/` is served at exactly the right URL
   with no redirect, which is what Digital Asset Links requires.
2. Sideload, sign in once, and compare the wallet address against what the SAME
   passkey produces in Chrome on the same phone. **If those two differ, stop.**
   A different address means the ceremony ran under a different origin, and
   shipping it would strand balances.


## iOS

Same shape as Android and the same one thing that decides it: a WKWebView
refuses WebAuthn outright unless the app declares an Associated Domain for the
relying-party id and the site serves a matching file. Both halves are in place.

| Piece | State |
|---|---|
| App ID `xyz.empowertours.app` (explicit, Associated Domains) | registered, prefix `VYPJ7L4YTB` |
| `App.entitlements` → `webcredentials:` apex + both subdomains | committed |
| `apple-app-site-association` on the apex | live, `application/json`, no redirect |
| …confirmed through Apple's own CDN | `app-site-association.cdn-apple.com/a/v1/empowertours.xyz` |
| `DEVELOPMENT_TEAM` | `VYPJ7L4YTB` in both configurations |
| Shared scheme | `App.xcodeproj/xcshareddata/xcschemes/App.xcscheme` |

### Building it

There is no Mac here — this box is WSL and the Mac Mini runs Ubuntu — so
`.github/workflows/ios.yml` builds on GitHub's macOS runners. The repo is
public, so those minutes are free; the 10x macOS multiplier bills private repos
only.

Two jobs, split on purpose. **compile** needs no secrets and no Apple account:
it proves the project builds, the SPM packages resolve and the entitlements
parse, and it runs on every push touching `mobile/`. **archive** signs, exports
and uploads to TestFlight, and *skips itself* when the credentials are absent —
a workflow that goes red for a secret nobody has created yet only teaches
people to ignore red workflows.

### To enable the signed build

Create an **App Store Connect API key** (App Store Connect → Users and Access →
Integrations → App Store Connect API, role *App Manager*), then set three repo
secrets:

```
APP_STORE_CONNECT_KEY_ID        the 10-character key id
APP_STORE_CONNECT_ISSUER_ID     the issuer UUID, shown once at the top of that page
APP_STORE_CONNECT_PRIVATE_KEY   the whole .p8 file, BEGIN/END lines included
```

An API key rather than a distribution certificate and a `.p12` in a secret:
Xcode then creates and refreshes provisioning profiles itself under
`-allowProvisioningUpdates`, so nobody ever exports a private key and there is
no certificate to expire silently in eleven months. **The `.p8` downloads
exactly once and Apple keeps no copy** — lose it and the only path is to revoke
and issue another.

An App Store Connect app record for `xyz.empowertours.app` also has to exist
before the first upload is accepted.

### What TestFlight is and is not

Uploading to TestFlight is not submitting to the App Store. **Internal testers
get the build with no review at all**, which matters here: App Review's
guideline 4.2 treats a WebView shell as a repackaged website and the current
consensus is that it gets rejected. TestFlight is the honest target for handing
this to a judge or a tester; the public App Store would need real native work.
