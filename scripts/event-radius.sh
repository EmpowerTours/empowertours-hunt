#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# event-radius.sh — set the spawn annulus (how far from the player a prize lands).
#
# A spawn is placed at a random bearing, distance in [min,max] from the player's
# last VERIFIED fix, then rejected unless it falls inside an active INCLUDE zone.
# Only 10 placement attempts are made (app/api/hunt/[huntId]/spawn/route.ts:231)
# before the route gives up with "no_walkable_ground" — so an annulus that is
# large relative to the zone box silently stops producing spawns.
#
# Rule of thumb: keep max well under the zone's half-size (geofence-expo.sh).
#
#   bash scripts/event-radius.sh <min> <max>   # metres, min strictly < max
#   bash scripts/event-radius.sh off           # restore 15 / 40
#   bash scripts/event-radius.sh status
# ---------------------------------------------------------------------------
set -euo pipefail

HUNT="${HUNT_ID:-cmtlobsc20000n82wu2x3z2va}"
SERVICE="${RAILWAY_SERVICE:-hunt-web}"

case "${1:-}" in
  off)    MIN=15; MAX=40 ;;
  status) MIN="status"; MAX="status" ;;
  "")     echo "usage: $0 <minM> <maxM> | off | status" >&2; exit 1 ;;
  *)      MIN="$1"; MAX="${2:?need max}"
          for v in "$MIN" "$MAX"; do
            if ! [[ "$v" =~ ^[0-9]+$ ]] || [ "$v" -lt 1 ]; then
              echo "min and max must be positive integers" >&2; exit 1
            fi
          done
          if [ "$MIN" -ge "$MAX" ]; then
            echo "min must be strictly less than max (lib/admin/hunt-input.ts:223)" >&2; exit 1
          fi ;;
esac

read -r -d '' JS <<'EOF' || true
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
const HUNT="__HUNT__", MIN="__MIN__", MAX="__MAX__";
const SEL={spawnMinRadiusM:true,spawnMaxRadiusM:true,spawnTtlSeconds:true,maxAccuracyM:true};
function halfMetres(zs){let a=90,b=-90,c=180,d=-180;for(const z of zs)for(const v of (z.vertices||[])){
  a=Math.min(a,v.lat);b=Math.max(b,v.lat);c=Math.min(c,v.lng);d=Math.max(d,v.lng);}
  if(!isFinite(a)||a===90)return null;
  const midLat=(a+b)/2;
  return {latHalfM:Math.round((b-a)*111320/2),lngHalfM:Math.round((d-c)*111320*Math.cos(midLat*Math.PI/180)/2)};}
(async()=>{
  const before=await p.hunt.findUnique({where:{id:HUNT},select:SEL});
  if(!before){console.error("hunt not found: "+HUNT);process.exit(1);}
  const zs=await p.zone.findMany({where:{huntId:HUNT,kind:"INCLUDE",active:true},select:{vertices:true}});
  const half=halfMetres(zs);
  if(MIN==="status"){console.log(JSON.stringify({hunt:before,zoneHalfMetres:half},null,2));return p.$disconnect();}
  const after=await p.hunt.update({where:{id:HUNT},data:{spawnMinRadiusM:Number(MIN),spawnMaxRadiusM:Number(MAX)},select:SEL});
  console.log(JSON.stringify({was:{min:before.spawnMinRadiusM,max:before.spawnMaxRadiusM},now:{min:after.spawnMinRadiusM,max:after.spawnMaxRadiusM},hunt:after,zoneHalfMetres:half},null,2));
  if(half&&Number(MAX)>Math.min(half.latHalfM,half.lngHalfM))
    console.log("WARNING: max ("+MAX+"m) exceeds the zone half-size ("+Math.min(half.latHalfM,half.lngHalfM)+"m). Most of the annulus falls outside the box; expect 'no_walkable_ground' and missing spawns.");
  if(Number(MAX)<after.maxAccuracyM)
    console.log("NOTE: max ("+MAX+"m) is smaller than maxAccuracyM ("+after.maxAccuracyM+"m). The prize is inside the player's own GPS error circle — there is nothing to walk to, only something to tap.");
  return p.$disconnect();
})().catch(e=>{console.error("ERR:",e.message);process.exit(1);});
EOF

JS="${JS//__HUNT__/$HUNT}"
JS="${JS//__MIN__/$MIN}"
JS="${JS//__MAX__/$MAX}"

B64="$(printf '%s' "$JS" | base64 -w0)"
railway ssh -s "$SERVICE" "node -e \"eval(Buffer.from('$B64','base64').toString())\""
