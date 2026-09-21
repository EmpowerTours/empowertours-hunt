#!/usr/bin/env bash
# Create and install the edition relayer key.
#
# Run this in YOUR OWN terminal, not through an agent. It deliberately never
# prints the private key: it writes it to a 0600 file, pushes it straight into
# Railway, and echoes only the address, which is public and is what hunters
# send their payment to.
#
# Idempotent by refusal: if the key file already exists it stops rather than
# generating a second wallet. A relayer that changes identity mid-flight
# strands every licence the old one bought and breaks the `payTo` on every
# card already on a phone.
set -euo pipefail

KEYFILE="${HOME}/.empowertours/edition-relayer.json"
mkdir -p "$(dirname "$KEYFILE")"
chmod 700 "$(dirname "$KEYFILE")"

if [ -e "$KEYFILE" ]; then
    echo "Key file already exists: $KEYFILE"
    echo "Refusing to generate a second relayer. Address currently on file:"
    python3 -c "import json;print(json.load(open('$KEYFILE'))['address'])"
    exit 0
fi

command -v cast >/dev/null || { echo "need foundry's cast on PATH"; exit 1; }

# cast prints both halves; capture, never echo.
OUT="$(cast wallet new)"
ADDR="$(printf '%s' "$OUT" | awk '/Address/{print $NF}')"
KEY="$(printf '%s' "$OUT" | awk '/Private key/{print $NF}')"
unset OUT

[ -n "$ADDR" ] && [ -n "$KEY" ] || { echo "could not parse cast output"; exit 1; }

umask 077
python3 - "$KEYFILE" "$ADDR" "$KEY" <<'PY'
import json, sys
path, addr, key = sys.argv[1], sys.argv[2], sys.argv[3]
json.dump(
    {
        "address": addr,
        "privateKey": key,
        "purpose": "empowertours-hunt EDITION_RELAYER_PRIVATE_KEY",
        "note": "Buys licences at the v3 SalesController and transfers them to hunters. "
                "Holds MON only; relayLicense wraps to WMON per sale. Hot wallet: fund it "
                "with what you are willing to cycle, nothing more.",
    },
    open(path, "w"),
    indent=2,
)
PY
chmod 600 "$KEYFILE"

echo "Relayer address : $ADDR"
echo "Key saved to    : $KEYFILE (0600)"
echo
echo "Next, from this repo, to install it without printing it:"
echo "  railway variables --set \"EDITION_RELAYER_PRIVATE_KEY=\$(python3 -c \"import json;print(json.load(open('$KEYFILE'))['privateKey'])\")\""
echo
echo "Then fund $ADDR with MON and turn editions on in /admin."
