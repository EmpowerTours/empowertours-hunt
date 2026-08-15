// Hunt list. VIEWER can read it; only OPERATOR can open a hunt's detail page,
// because that page shows cache coordinates.

import { AdminRole } from "@prisma/client";
import { requireAdminPage, roleAtLeast } from "@/lib/admin/auth";
import { listHunts } from "@/lib/admin/queries";
import { formatMon } from "@/lib/wei";
import { weiOf, timestamp } from "@/lib/admin/format";
import { CreateHuntForm } from "@/app/admin/_components/CreateHuntForm";
import {
  Badge,
  Panel,
  Table,
  Td,
  Th,
  Warning,
} from "@/app/admin/_components/ui";

export const dynamic = "force-dynamic";

export default async function HuntsPage() {
  const session = await requireAdminPage(AdminRole.VIEWER);
  const canOperate = roleAtLeast(session.role, AdminRole.OPERATOR);
  const hunts = await listHunts();

  return (
    <div className="flex flex-col gap-3">
      {!canOperate && (
        <Warning>
          VIEWER: hunt detail pages show cache coordinates and are restricted to
          OPERATOR and above.
        </Warning>
      )}

      {canOperate && (
        <Panel title="New hunt">
          <CreateHuntForm />
        </Panel>
      )}

      <Panel
        title="Hunts"
        subtitle="Open a hunt to edit its verifier rules, budgets, spawn configuration and caches."
      >
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>State</Th>
              <Th align="right">Caches</Th>
              <Th align="right">Finds</Th>
              <Th align="right">Spawns</Th>
              <Th align="right">MON spent / budget</Th>
              <Th align="right">Credit spent / budget</Th>
              <Th>Window</Th>
            </tr>
          </thead>
          <tbody>
            {hunts.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="px-2 py-6 text-center text-xs text-slate-600"
                >
                  No hunts yet.
                </td>
              </tr>
            )}
            {hunts.map((h) => (
              <tr key={h.id}>
                <Td>
                  {canOperate ? (
                    <a
                      className="text-slate-200 underline decoration-slate-700 hover:decoration-slate-400"
                      href={`/admin/hunts/${h.id}`}
                    >
                      {h.name}
                    </a>
                  ) : (
                    <span className="text-slate-300">{h.name}</span>
                  )}
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    <Badge tone={h.active ? "good" : "neutral"}>
                      {h.active ? "active" : "inactive"}
                    </Badge>
                    <Badge tone={h.spawnEnabled ? "warn" : "neutral"}>
                      {h.spawnEnabled ? "spawns on" : "spawns off"}
                    </Badge>
                  </div>
                </Td>
                <Td align="right" mono>
                  {h._count.caches}
                </Td>
                <Td align="right" mono>
                  {h._count.finds}
                </Td>
                <Td align="right" mono>
                  {h._count.spawns}
                </Td>
                <Td align="right" mono>
                  {formatMon(weiOf(h.spentMonWei))} /{" "}
                  {formatMon(weiOf(h.budgetMonWei))}
                </Td>
                <Td align="right" mono>
                  {formatMon(weiOf(h.spentCreditWei))} /{" "}
                  {formatMon(weiOf(h.budgetCreditWei))}
                </Td>
                <Td mono>
                  {timestamp(h.startsAt)} → {timestamp(h.endsAt)}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Panel>
    </div>
  );
}
