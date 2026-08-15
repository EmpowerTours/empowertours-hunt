import { AdminRole } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { requireAdminPage } from "@/lib/admin/auth";
import { timestamp } from "@/lib/admin/format";
import {
  AdminRoster,
  type AdminRow,
} from "@/app/admin/_components/AdminRoster";
import { Explain, Panel } from "@/app/admin/_components/ui";

export const dynamic = "force-dynamic";

export default async function AdminsPage() {
  const session = await requireAdminPage(AdminRole.OWNER);

  const admins = await prisma.adminUser.findMany({
    orderBy: [{ active: "desc" }, { createdAt: "asc" }],
    take: 200,
    select: {
      id: true,
      walletAddress: true,
      role: true,
      label: true,
      active: true,
      createdAt: true,
      _count: { select: { actions: true } },
    },
  });

  const rows: AdminRow[] = admins.map((a) => ({
    id: a.id,
    walletAddress: a.walletAddress,
    role: a.role,
    label: a.label,
    active: a.active,
    createdAt: timestamp(a.createdAt),
    actions: a._count.actions,
  }));

  return (
    <Panel
      title="Admins"
      subtitle="Wallet-signature login checked against this table. Addresses are stored lowercased."
    >
      <AdminRoster admins={rows} selfId={session.id} />
      <Explain>
        <strong>VIEWER</strong> reads every screen except hunt detail (which
        shows cache coordinates) and this one. <strong>OPERATOR</strong> can
        approve, void, send and reconcile payouts, edit hunts and caches, and
        suspend players. <strong>OWNER</strong> can additionally manage this
        roster. Every one of those is checked server-side on each request, not
        by hiding a button. Deactivating an admin takes effect on their very
        next request — the role is re-read from this table every time, never
        trusted from their session cookie.
      </Explain>
    </Panel>
  );
}
