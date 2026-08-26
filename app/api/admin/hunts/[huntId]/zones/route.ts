// List and create walkable zones. OPERATOR.
//
// Unlike caches, zone coordinates are NOT secret — a zone is the public shape
// of the streets, and the player map needs it to draw the playable area. So
// this route may echo vertices back, and GET returns them in full.
//
// What it must not do is accept a ring that cannot mean anything. A
// self-intersecting outline has no coherent inside, and a ring smaller than the
// GPS error that drew it is noise with corners; both would silently produce a
// zone that decides where money lands. `validateRing` is the gate, and it is
// the same function the survey UI runs, so nothing is accepted on the phone
// that the server then refuses.

import { AdminRole, ZoneKind } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { requestIp, requireAdminApi } from "@/lib/admin/auth";
import { logAdminAction } from "@/lib/admin/audit";
import { validateRing } from "@/lib/admin/zone";
import type { Ring } from "@/lib/geo/polygon";
import {
  adminErrorResponse,
  jsonError,
  jsonOk,
  readJson,
} from "@/lib/admin/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ huntId: string }> },
) {
  try {
    await requireAdminApi(AdminRole.OPERATOR);
    const { huntId } = await ctx.params;

    const zones = await prisma.zone.findMany({
      where: { huntId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        kind: true,
        name: true,
        vertices: true,
        active: true,
        createdAt: true,
      },
    });

    return jsonOk({ ok: true, zones });
  } catch (e) {
    return adminErrorResponse(e);
  }
}

interface ZoneCreateBody {
  kind?: unknown;
  name?: unknown;
  vertices?: unknown;
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ huntId: string }> },
) {
  try {
    const admin = await requireAdminApi(AdminRole.OPERATOR);
    const { huntId } = await ctx.params;
    const ip = await requestIp();

    const hunt = await prisma.hunt.findUnique({
      where: { id: huntId },
      select: { id: true },
    });
    if (!hunt) return jsonError("hunt not found", 404);

    const body = (await readJson(req)) as ZoneCreateBody;

    if (body.kind !== ZoneKind.INCLUDE && body.kind !== ZoneKind.EXCLUDE) {
      return jsonError("kind must be INCLUDE or EXCLUDE", 400);
    }
    const kind = body.kind;

    // Trust nothing about the shape of `vertices` — it lands in a Json column,
    // so whatever is written here is what the placement code later reads back.
    const validation = validateRing(body.vertices as Ring);
    if (!validation.ok) {
      return jsonError(`${validation.problem}: ${validation.detail}`, 400);
    }

    // Store a normalised copy rather than the caller's object: a client is free
    // to send vertices carrying extra keys, and none of them belong in a column
    // the spawn path reads on every request.
    const vertices = (body.vertices as Ring).map((v) => ({
      lat: v.lat,
      lng: v.lng,
    }));

    const name =
      typeof body.name === "string" && body.name.trim().length > 0
        ? body.name.trim().slice(0, 120)
        : null;

    const zone = await prisma.zone.create({
      data: { huntId, kind, name, vertices, active: true },
      select: { id: true },
    });

    await logAdminAction({
      adminId: admin.id,
      action: "zone.create",
      targetType: "Zone",
      targetId: zone.id,
      detail: `hunt=${huntId} ${kind} "${name ?? "unnamed"}" ${validation.vertices} corners ${Math.round(validation.areaSquareMeters)}m2 perimeter ${Math.round(validation.perimeterMeters)}m`,
      ip,
    });

    return jsonOk(
      {
        ok: true,
        zoneId: zone.id,
        vertices: validation.vertices,
        areaSquareMeters: Math.round(validation.areaSquareMeters),
        perimeterMeters: Math.round(validation.perimeterMeters),
      },
      201,
    );
  } catch (e) {
    return adminErrorResponse(e);
  }
}
