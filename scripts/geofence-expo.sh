#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# geofence-expo.sh — point the "Cualquier Ciudad" hunt at one INCLUDE box and
# deactivate every other zone, so spawns land ONLY where the crowd is.
#
# Runs the DB write INSIDE the Railway container (the prod DB host is internal),
# so it works from the laptop OR from a phone over Termius SSH into the laptop.
# It does NOT start a Claude session — it's a plain command.
#
#   bash scripts/geofence-expo.sh <lat> <lng> [halfMeters]   # geofence ON
#   bash scripts/geofence-expo.sh off                        # revert (Chilpancingo back)
#   bash scripts/geofence-expo.sh status                     # what's active now
#
# Example, standing in the middle of the hall:
#   bash scripts/geofence-expo.sh 19.4402 -99.2241 120
#
# halfMeters defaults to 200 (a generous box). For a hall-tight box that still
# survives indoor GPS drift, pass ~100-150.
# ---------------------------------------------------------------------------
set -euo pipefail

HUNT="${HUNT_ID:-cmtlobsc20000n82wu2x3z2va}"
SERVICE="${RAILWAY_SERVICE:-hunt-web}"

MODE="on"; LAT="0"; LNG="0"; HALF="200"
case "${1:-}" in
  off)    MODE="off" ;;
  status) MODE="status" ;;
  global) MODE="global"; HALF="${2:-40}" ;;   # play anywhere; HALF = unsurveyedSpawnRadiusM
  "")     echo "usage: $0 <lat> <lng> [halfMeters] | global [radiusM] | off | status" >&2; exit 1 ;;
  *)      MODE="on"; LAT="$1"; LNG="${2:?need lng}"; HALF="${3:-200}" ;;
esac

# The DB logic. Placeholders are substituted below, then base64'd into the
# container. Quoted heredoc so the laptop shell touches nothing (note $disconnect).
read -r -d '' JS <<'EOF' || true
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
const MODE="__MODE__", HUNT="__HUNT__", EXPO="expo-hall";
const LAT=Number("__LAT__"), LNG=Number("__LNG__"), HALF=Number("__HALF__");
function box(lat,lng,half){
  const dLat=half/111320, dLng=half/(111320*Math.cos(lat*Math.PI/180));
  return [
    {lat:lat-dLat,lng:lng-dLng},{lat:lat-dLat,lng:lng+dLng},
    {lat:lat+dLat,lng:lng+dLng},{lat:lat+dLat,lng:lng-dLng},
  ];
}
function inRing(pt,ring){let c=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){
  const xi=ring[i].lng,yi=ring[i].lat,xj=ring[j].lng,yj=ring[j].lat;
  if(((yi>pt.lat)!=(yj>pt.lat))&&(pt.lng<(xj-xi)*(pt.lat-yi)/(yj-yi)+xi))c=!c;}return c;}
function bbox(zs){let a=90,b=-90,c=180,d=-180,n=0;for(const z of zs)for(const v of (z.vertices||[])){
  a=Math.min(a,v.lat);b=Math.max(b,v.lat);c=Math.min(c,v.lng);d=Math.max(d,v.lng);n++;}
  return {minLat:+a.toFixed(6),maxLat:+b.toFixed(6),minLng:+c.toFixed(6),maxLng:+d.toFixed(6),vertices:n};}
(async()=>{
  if(MODE==="status"){
    const zs=await p.zone.findMany({where:{huntId:HUNT,kind:"INCLUDE",active:true},select:{name:true,vertices:true}});
    const h=await p.hunt.findUnique({where:{id:HUNT},select:{spawnEnabled:true,unsurveyedSpawnRadiusM:true,spawnMinRadiusM:true,spawnMaxRadiusM:true,spawnTtlSeconds:true}});
    console.log(JSON.stringify({activeIncludeZones:zs.length,bbox:bbox(zs),hunt:h},null,2));
    return p.$disconnect();
  }
  if(MODE==="global"){
    const deac=await p.zone.updateMany({where:{huntId:HUNT,kind:"INCLUDE",active:true},data:{active:false}});
    await p.hunt.update({where:{id:HUNT},data:{unsurveyedSpawnRadiusM:Math.round(HALF)}});
    const n=await p.zone.count({where:{huntId:HUNT,kind:"INCLUDE",active:true}});
    console.log("GLOBAL play — deactivated "+deac.count+" INCLUDE zones, unsurveyedSpawnRadiusM="+Math.round(HALF)+", activeIncludeZonesNow="+n);
    return p.$disconnect();
  }
  if(MODE==="off"){
    const off=await p.zone.updateMany({where:{huntId:HUNT,name:{startsWith:EXPO},active:true},data:{active:false}});
    const on=await p.zone.updateMany({where:{huntId:HUNT,name:{startsWith:"osm-"},active:false},data:{active:true}});
    await p.hunt.update({where:{id:HUNT},data:{unsurveyedSpawnRadiusM:0}});
    console.log("REVERTED — expo zones off="+off.count+", osm(Chilpancingo) reactivated="+on.count);
    return p.$disconnect();
  }
  if(!Number.isFinite(LAT)||!Number.isFinite(LNG)){console.error("need lat lng");process.exit(1);}
  const ring=box(LAT,LNG,HALF);
  if(!inRing({lat:LAT,lng:LNG},ring)){console.error("sanity: center not in ring");process.exit(1);}
  const deac=await p.zone.updateMany({where:{huntId:HUNT,kind:"INCLUDE",active:true,NOT:{name:{startsWith:EXPO}}},data:{active:false}});
  await p.zone.updateMany({where:{huntId:HUNT,name:{startsWith:EXPO}},data:{active:false}});
  const z=await p.zone.create({data:{huntId:HUNT,kind:"INCLUDE",source:"ADMIN",name:EXPO,vertices:ring,active:true}});
  await p.hunt.update({where:{id:HUNT},data:{unsurveyedSpawnRadiusM:0}});
  const n=await p.zone.count({where:{huntId:HUNT,kind:"INCLUDE",active:true}});
  console.log(JSON.stringify({geofence:"ON",center:{lat:LAT,lng:LNG},halfMeters:HALF,deactivatedOtherZones:deac.count,activeIncludeZonesNow:n,zoneId:z.id,ring},null,2));
  return p.$disconnect();
})().catch(e=>{console.error("ERR:",e.message);process.exit(1);});
EOF

JS="${JS//__MODE__/$MODE}"
JS="${JS//__HUNT__/$HUNT}"
JS="${JS//__LAT__/$LAT}"
JS="${JS//__LNG__/$LNG}"
JS="${JS//__HALF__/$HALF}"

B64="$(printf '%s' "$JS" | base64 -w0)"
railway ssh -s "$SERVICE" "node -e \"eval(Buffer.from('$B64','base64').toString())\""
