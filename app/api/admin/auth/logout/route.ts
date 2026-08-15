import { NextResponse } from "next/server";
import {
  ADMIN_NONCE_COOKIE,
  ADMIN_SESSION_COOKIE,
  clearedCookie,
} from "@/lib/admin/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  for (const name of [ADMIN_SESSION_COOKIE, ADMIN_NONCE_COOKIE]) {
    const c = clearedCookie(name);
    res.cookies.set(c.name, c.value, c.options);
  }
  return res;
}
