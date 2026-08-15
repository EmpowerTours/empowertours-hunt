// The audit trail.
//
// Append-only by construction: there is no edit control on this page and no
// route in the admin lane that updates or deletes an AdminAction row. Refused
// transitions are recorded alongside successful ones, so "who tried to approve
// a payout that had already been broadcast" is answerable.

import { AdminRole } from "@prisma/client";
import { requireAdminPage } from "@/lib/admin/auth";
import { listAdminActions } from "@/lib/admin/queries";
import { first, pageHref, parsePage } from "@/lib/admin/pagination";
import { relative, shortAddress, timestamp } from "@/lib/admin/format";
import {
  Badge,
  Explain,
  Pager,
  Panel,
  Table,
  Td,
  Th,
} from "@/app/admin/_components/ui";

export const dynamic = "force-dynamic";

const TONE: Record<string, "neutral" | "good" | "warn" | "bad" | "alarm"> = {
  "payout.approve": "good",
  "payout.approve.batch": "good",
  "payout.void": "neutral",
  "payout.send": "warn",
  "payout.reconcile": "alarm",
  "payout.transition.denied": "bad",
  "player.suspend": "bad",
  "player.unsuspend": "good",
  "player.credit.adjust": "warn",
  "admin.create": "warn",
  "admin.update": "warn",
  "admin.bootstrap": "alarm",
};

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminPage(AdminRole.VIEWER);
  const sp = await searchParams;
  const page = parsePage(sp, 100);

  const { rows, total } = await listAdminActions({
    page,
    adminId: first(sp.adminId),
    targetId: first(sp.targetId),
  });

  return (
    <Panel
      title="Audit trail"
      subtitle="Every privileged mutation, plus every refused one. Append-only — rows are never updated or deleted."
    >
      <Table>
        <thead>
          <tr>
            <Th>When</Th>
            <Th>Admin</Th>
            <Th>Action</Th>
            <Th>Target</Th>
            <Th>Detail</Th>
            <Th>IP</Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={6}
                className="px-2 py-6 text-center text-xs text-slate-600"
              >
                Nothing recorded yet.
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.id}>
              <Td mono>
                <span title={timestamp(r.createdAt)}>
                  {relative(r.createdAt)}
                </span>
              </Td>
              <Td>
                <a
                  className="font-mono text-slate-300 underline decoration-slate-700 hover:decoration-slate-400"
                  href={`/admin/audit?adminId=${r.adminId}`}
                  title={r.admin.walletAddress}
                >
                  {shortAddress(r.admin.walletAddress)}
                </a>
                <div className="text-[10px] text-slate-500">
                  {r.admin.label ?? r.admin.role}
                </div>
              </Td>
              <Td>
                <Badge tone={TONE[r.action] ?? "neutral"}>{r.action}</Badge>
              </Td>
              <Td>
                <a
                  className="text-slate-400 underline decoration-slate-800 hover:decoration-slate-500"
                  href={`/admin/audit?targetId=${encodeURIComponent(r.targetId)}`}
                >
                  {r.targetType}
                </a>
                <div className="font-mono text-[10px] text-slate-600">
                  {r.targetId}
                </div>
              </Td>
              <Td>
                <span className="break-all text-slate-400">
                  {r.detail ?? "—"}
                </span>
              </Td>
              <Td mono>{r.ip ?? "—"}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <Pager
        page={page.page}
        take={page.take}
        total={total}
        hrefFor={(p) => pageHref("/admin/audit", sp, p)}
      />
      <Explain>
        Cache coordinates appear in{" "}
        <span className="font-mono">cache.create</span> and{" "}
        <span className="font-mono">cache.update</span> details. That is
        deliberate — the trail has to be able to answer &ldquo;who moved a cache
        and where to&rdquo; — and it is why this page, like the cache screen, is
        admin-only.
      </Explain>
    </Panel>
  );
}
