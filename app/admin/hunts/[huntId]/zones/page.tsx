// Zone survey. OPERATOR and above.
//
// Sits under the hunt rather than beside the cache survey because a zone only
// means anything in the context of one hunt — it is that hunt's walkable
// ground, and the spawn path reads it per-hunt on every request.

import { notFound } from "next/navigation";
import { AdminRole } from "@prisma/client";
import { requireAdminPage } from "@/lib/admin/auth";
import { prisma } from "@/lib/db/prisma";
import { ZoneSurvey } from "@/app/admin/_components/ZoneSurvey";

export const dynamic = "force-dynamic";

export default async function ZonesPage({
  params,
}: {
  params: Promise<{ huntId: string }>;
}) {
  await requireAdminPage(AdminRole.OPERATOR);
  const { huntId } = await params;

  const hunt = await prisma.hunt.findUnique({
    where: { id: huntId },
    select: { id: true, name: true },
  });
  if (!hunt) notFound();

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-100">
        Walkable ground — {hunt.name}
      </h1>
      <ZoneSurvey huntId={hunt.id} />
    </div>
  );
}
