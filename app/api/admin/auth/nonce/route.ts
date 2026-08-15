// Issue a single-use login challenge.
//
// Rate-limited on IP before anything else happens: this endpoint is the only
// unauthenticated surface in the admin lane, and a nonce mint is cheap enough
// to be worth flooding if nothing stops it.

import { NextResponse } from "next/server";
import { checkLimit } from "@/lib/ratelimit";
import { issueNonce } from "@/lib/admin/session";
import {
  requestIp,
  ADMIN_CHAIN_ID,
  ADMIN_SIWE_STATEMENT,
} from "@/lib/admin/auth";
import { adminErrorResponse, jsonError } from "@/lib/admin/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const ip = await requestIp();
    const limit = await checkLimit("admin", { ip });
    if (!limit.ok) {
      return jsonError("too many login attempts, slow down", 429);
    }

    const { nonce, cookie } = issueNonce();
    const res = NextResponse.json({
      nonce,
      chainId: ADMIN_CHAIN_ID,
      statement: ADMIN_SIWE_STATEMENT,
    });
    res.cookies.set(cookie.name, cookie.value, cookie.options);
    return res;
  } catch (e) {
    return adminErrorResponse(e);
  }
}
