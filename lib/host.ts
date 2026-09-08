import { headers } from "next/headers";

// One app, two public hosts. hunt.empowertours.xyz is the game;
// cota.empowertours.xyz is the trading app ONLY and must not show the hunt
// game. Host is read from x-forwarded-host (Railway rewrites Host — see the
// same pattern in lib/admin/auth.ts), falling back to host.

/** True when this request is for the cota.* trading host. Server-only. */
export async function isCotaHost(): Promise<boolean> {
  const h = await headers();
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").toLowerCase();
  return host.startsWith("cota.");
}
