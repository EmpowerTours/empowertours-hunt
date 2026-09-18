#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# assetlinks.sh — print the Digital Asset Links file this app needs, filled in
# with the SHA-256 fingerprint of a real signing key.
#
# WHY THIS EXISTS AND WHY IT IS NOT OPTIONAL
#
# A passkey belongs to a relying party, not to an app. Android will only let
# xyz.empowertours.cota use credentials scoped to empowertours.xyz if that
# domain says, in writing and over https, that it delegates login credentials
# to this exact package signed by this exact key. Without the file the WebView
# ceremony fails the same way it fails for any unrelated app — which is the
# correct behaviour, and is also indistinguishable from "the app is broken".
#
#   bash scripts/assetlinks.sh                       # debug keystore
#   bash scripts/assetlinks.sh path/to/release.jks alias
#
# Output goes to https://empowertours.xyz/.well-known/assetlinks.json — the RP
# ID host, which is NOT this repo. See mobile/README.md.
# ---------------------------------------------------------------------------
set -euo pipefail

PACKAGE="${PACKAGE:-xyz.empowertours.app}"
STORE="${1:-$HOME/.android/debug.keystore}"
ALIAS="${2:-androiddebugkey}"
STOREPASS="${STOREPASS:-android}"

if [ ! -f "$STORE" ]; then
  echo "keystore not found: $STORE" >&2
  echo "For a debug key, build the app once (Gradle creates ~/.android/debug.keystore)," >&2
  echo "or generate a release key with:" >&2
  echo "  keytool -genkeypair -v -keystore release.jks -alias cota -keyalg RSA -keysize 4096 -validity 10000" >&2
  exit 1
fi

# -storepass is passed on the command line only for the WELL-KNOWN debug
# password. A release keystore prompts instead, so its password never lands in
# a shell history or a process list.
if [ "$STORE" = "$HOME/.android/debug.keystore" ]; then
  RAW="$(keytool -list -v -keystore "$STORE" -alias "$ALIAS" -storepass "$STOREPASS" 2>/dev/null)"
else
  RAW="$(keytool -list -v -keystore "$STORE" -alias "$ALIAS" 2>/dev/null)"
fi

FP="$(printf '%s' "$RAW" | awk -F': ' '/SHA256:/ {print $2; exit}' | tr -d '[:space:]')"
if [ -z "$FP" ]; then
  echo "could not read a SHA-256 fingerprint from $STORE (alias $ALIAS)" >&2
  exit 1
fi

cat <<JSON
[
  {
    "relation": ["delegate_permission/common.get_login_creds"],
    "target": {
      "namespace": "android_app",
      "package_name": "$PACKAGE",
      "sha256_cert_fingerprints": ["$FP"]
    }
  }
]
JSON

echo >&2
echo "Serve the JSON above at:" >&2
echo "  https://empowertours.xyz/.well-known/assetlinks.json" >&2
echo "Content-Type MUST be application/json and it must be reachable over https" >&2
echo "with no redirect. Verify with:" >&2
echo "  curl -sI https://empowertours.xyz/.well-known/assetlinks.json" >&2
