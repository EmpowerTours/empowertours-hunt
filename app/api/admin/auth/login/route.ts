// Admin login: verify a SIWE signature, mint a session.
//
// Failure is uniform ("invalid login") whatever went wrong. Distinguishing
// "not an admin" from "bad signature" would turn this endpoint into a free
// oracle for which wallets hold operator access.

import { NextResponse } from "next/server";
import { checkLimit } from "@/lib/ratelimit";
import { requestIp, verifyAdminLogin } from "@/lib/admin/auth";
import { logAdminAction } from "@/lib/admin/audit";
import {
  adminErrorResponse,
  jsonError,
  readJson,
  requireString,
} from "@/lib/admin/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const ip = await requestIp();
    const limit = await checkLimit("admin", { ip });
    if (!limit.ok) {
      return jsonError("too many login attempts, slow down", 429);
    }

    const body = await readJson(req);
    const message = requireString(body, "message", { min: 32, max: 4000 });
    const signature = requireString(body, "signature", { min: 4, max: 400 });

    const { session, cookies } = await verifyAdminLogin(message, signature);

    // A login is a privileged event in its own right — it is what every
    // subsequent action in the trail hangs off.
    await logAdminAction({
      adminId: session.id,
      action: "admin.login",
      targetType: "Session",
      targetId: session.id,
      detail: `role=${session.role}`,
      ip,
    });

    const res = NextResponse.json({
      admin: {
        id: session.id,
        walletAddress: session.walletAddress,
        role: session.role,
        label: session.label,
      },
    });
    for (const c of cookies) res.cookies.set(c.name, c.value, c.options);
    return res;
  } catch (e) {
    return adminErrorResponse(e);
  }
}
