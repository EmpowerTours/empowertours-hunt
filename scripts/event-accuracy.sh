#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# event-accuracy.sh — set the hunt's maxAccuracyM (the GPS-certainty gate that
# every check-in and every claim is measured against).
#
# Indoors an iPhone on cellular reads +/-70m or worse, and the default 30m gate
# blocks CHECK-IN, which means no verified fix, which means NO SPAWNS AT ALL.
# Raising it trades anti-spoof strength for an event that actually works.
#
# Runs the DB write INSIDE the Railway container (prod DB host is internal), so
# it works from the laptop OR from a phone over Termius SSH. Not a Claude session.
#
#   bash scripts/event-accuracy.sh <metres>   # set the gate (1-500)
#   bash scripts/event-accuracy.sh off        # restore the 30m default
#   bash scripts/event-accuracy.sh status     # what it is now
# ---------------------------------------------------------------------------
set -euo pipefail

HUNT="${HUNT_ID:-cmtlobsc20000n82wu2x3z2va}"
SERVICE="${RAILWAY_SERVICE:-hunt-web}"
DEFAULT_ACCURACY=30

case "${1:-}" in
  off)    VAL="$DEFAULT_ACCURACY" ;;
  status) VAL="status" ;;
  "")     echo "usage: $0 <metres 1-500> | off | status" >&2; exit 1 ;;
  *)      VAL="$1"
          if ! [[ "$VAL" =~ ^[0-9]+$ ]] || [ "$VAL" -lt 1 ] || [ "$VAL" -gt 500 ]; then
            echo "metres must be an integer 1-500 (schema limit)" >&2; exit 1
          fi ;;
esac

read -r -d '' JS <<'EOF' || true
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
const HUNT="__HUNT__", VAL="__VAL__";
const SEL={maxAccuracyM:true,maxSpeedKmh:true,cooldownSeconds:true,spawnMinRadiusM:true,spawnMaxRadiusM:true};
(async()=>{
  const before=await p.hunt.findUnique({where:{id:HUNT},select:SEL});
  if(!before){console.error("hunt not found: "+HUNT);process.exit(1);}
  if(VAL==="status"){console.log(JSON.stringify(before,null,2));return p.$disconnect();}
  const n=Number(VAL);
  const after=await p.hunt.update({where:{id:HUNT},data:{maxAccuracyM:n},select:SEL});
  console.log(JSON.stringify({was:before.maxAccuracyM,now:after.maxAccuracyM,hunt:after},null,2));
  if(n>after.spawnMaxRadiusM)console.log("NOTE: gate ("+n+"m) exceeds spawnMaxRadiusM ("+after.spawnMaxRadiusM+"m) — 'walk to the prize' is now inside the noise; the game is effectively 'be in the venue'.");
  return p.$disconnect();
})().catch(e=>{console.error("ERR:",e.message);process.exit(1);});
EOF

JS="${JS//__HUNT__/$HUNT}"
JS="${JS//__VAL__/$VAL}"

B64="$(printf '%s' "$JS" | base64 -w0)"
railway ssh -s "$SERVICE" "node -e \"eval(Buffer.from('$B64','base64').toString())\""
