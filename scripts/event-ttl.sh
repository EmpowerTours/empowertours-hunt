#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# event-ttl.sh — set how long a spawn stays alive before it expires.
#
# A spawn lands 15-40 m away; if the TTL is shorter than the walk (crowds,
# stairs, a stand in the way) the prize evaporates before anyone reaches it and
# the player sees nothing but a flicker. The app DEFAULT is 900s; the event was
# running on 60s, which is where "it disappears before I get there" comes from.
#
# Runs the DB write INSIDE the Railway container (prod DB host is internal), so
# it works from the laptop OR from a phone over Termius SSH. Not a Claude session.
#
#   bash scripts/event-ttl.sh <seconds>   # set the TTL (30-86400)
#   bash scripts/event-ttl.sh off         # restore the 900s app default
#   bash scripts/event-ttl.sh status      # what it is now
# ---------------------------------------------------------------------------
set -euo pipefail

HUNT="${HUNT_ID:-cmtlobsc20000n82wu2x3z2va}"
SERVICE="${RAILWAY_SERVICE:-hunt-web}"
DEFAULT_TTL=900   # prisma/schema.prisma:302

case "${1:-}" in
  off)    VAL="$DEFAULT_TTL" ;;
  status) VAL="status" ;;
  "")     echo "usage: $0 <seconds 30-86400> | off | status" >&2; exit 1 ;;
  *)      VAL="$1"
          if ! [[ "$VAL" =~ ^[0-9]+$ ]] || [ "$VAL" -lt 30 ] || [ "$VAL" -gt 86400 ]; then
            echo "seconds must be an integer 30-86400 (schema limit)" >&2; exit 1
          fi ;;
esac

read -r -d '' JS <<'EOF' || true
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
const HUNT="__HUNT__", VAL="__VAL__";
const SEL={spawnTtlSeconds:true,spawnCooldownSeconds:true,spawnMinRadiusM:true,spawnMaxRadiusM:true,maxAccuracyM:true};
(async()=>{
  const before=await p.hunt.findUnique({where:{id:HUNT},select:SEL});
  if(!before){console.error("hunt not found: "+HUNT);process.exit(1);}
  if(VAL==="status"){console.log(JSON.stringify(before,null,2));return p.$disconnect();}
  const n=Number(VAL);
  const after=await p.hunt.update({where:{id:HUNT},data:{spawnTtlSeconds:n},select:SEL});
  const live=await p.spawn.count({where:{huntId:HUNT,collectedAt:null,expiresAt:{gt:new Date()}}});
  console.log(JSON.stringify({was:before.spawnTtlSeconds,now:after.spawnTtlSeconds,hunt:after,liveSpawnsRightNow:live},null,2));
  console.log("NOTE: expiresAt is stamped when a spawn is CREATED — spawns already on someone's screen keep their old "+before.spawnTtlSeconds+"s deadline. Only spawns created from now on get "+n+"s.");
  return p.$disconnect();
})().catch(e=>{console.error("ERR:",e.message);process.exit(1);});
EOF

JS="${JS//__HUNT__/$HUNT}"
JS="${JS//__VAL__/$VAL}"

B64="$(printf '%s' "$JS" | base64 -w0)"
railway ssh -s "$SERVICE" "node -e \"eval(Buffer.from('$B64','base64').toString())\""
