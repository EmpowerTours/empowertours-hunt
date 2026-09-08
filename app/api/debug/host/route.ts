import { NextResponse } from "next/server";

// Temporary diagnostic: echoes the host-identifying headers so we can see which
// one carries the public hostname behind Railway's proxy. Remove with the
// /cota/diag scaffolding once cross-subdomain routing is confirmed.
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const h = req.headers;
  return NextResponse.json({
    host: h.get("host"),
    xForwardedHost: h.get("x-forwarded-host"),
    xForwardedProto: h.get("x-forwarded-proto"),
    forwarded: h.get("forwarded"),
  });
}
