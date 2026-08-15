import { NextResponse } from "next/server";
import { newNonce } from "@/lib/auth/mera";
import { CLOCK_SKEW_SECONDS, HUNT_DOMAIN, SESSION_STATEMENT } from "@/lib/auth";

// Nothing is stored when a nonce is issued — single use is enforced at
// CONSUMPTION, by an atomic SET NX in the nonce store. That means this endpoint
// holds no state an attacker can exhaust, so it needs no rate limit of its own
// and cannot be used to evict anyone else's pending nonce.
//
// A client is equally free to generate its own random nonce; this endpoint
// exists so there is one authoritative statement of the accepted format and of
// the domain the client must sign over.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    {
      nonce: newNonce(),
      // Unix seconds. The client puts this in `clientTs`; the server rejects
      // anything further than clockSkewSeconds from its own clock.
      serverTs: Math.floor(Date.now() / 1000),
      clockSkewSeconds: CLOCK_SKEW_SECONDS,
      domain: HUNT_DOMAIN,
      sessionStatement: SESSION_STATEMENT,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
