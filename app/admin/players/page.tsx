import { AdminRole } from "@prisma/client";
import { requireAdminPage, roleAtLeast } from "@/lib/admin/auth";
import { listPlayers } from "@/lib/admin/queries";
import { formatMon } from "@/lib/wei";
import { relative, shortAddress, timestamp } from "@/lib/admin/format";
import { first, pageHref, parsePage } from "@/lib/admin/pagination";
import { SuspendControl } from "@/app/admin/_components/SuspendControl";
import { Badge, Pager, Panel, Table, Td, Th } from "@/app/admin/_components/ui";

export const dynamic = "force-dynamic";

export default async function PlayersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireAdminPage(AdminRole.VIEWER);
  const sp = await searchParams;
  const page = parsePage(sp, 50);
  const q = first(sp.q);
  const suspendedOnly = first(sp.suspended) === "1";
  const canOperate = roleAtLeast(session.role, AdminRole.OPERATOR);

  const { rows, total } = await listPlayers({ page, q, suspendedOnly });

  return (
    <Panel
      title="Players"
      subtitle="Search by wallet address or TURBO username."
      actions={
        <form method="get" action="/admin/players" className="flex gap-1">
          <input
            name="q"
            defaultValue={q ?? ""}
            placeholder="0x… or @turbo"
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
          />
          <label className="flex items-center gap-1 text-[11px] text-slate-400">
            <input
              type="checkbox"
              name="suspended"
              value="1"
              defaultChecked={suspendedOnly}
            />
            suspended only
          </label>
          <button className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800">
            search
          </button>
        </form>
      }
    >
      <Table>
        <thead>
          <tr>
            <Th>Wallet</Th>
            <Th>TURBO</Th>
            <Th>State</Th>
            <Th align="right">Finds</Th>
            <Th align="right">Credit (WMON)</Th>
            <Th>Joined</Th>
            <Th>Action</Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={7}
                className="px-2 py-6 text-center text-xs text-slate-600"
              >
                No players match.
              </td>
            </tr>
          )}
          {rows.map((p) => (
            <tr key={p.id}>
              <Td>
                <a
                  className="font-mono text-slate-200 underline decoration-slate-700 hover:decoration-slate-400"
                  href={`/admin/players/${p.id}`}
                  title={p.walletAddress}
                >
                  {shortAddress(p.walletAddress)}
                </a>
              </Td>
              <Td>{p.turboUsername ? `@${p.turboUsername}` : "—"}</Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  {p.suspendedAt ? (
                    <Badge tone="bad" title={p.suspendReason ?? undefined}>
                      suspended {relative(p.suspendedAt)}
                    </Badge>
                  ) : p.active ? (
                    <Badge tone="good">active</Badge>
                  ) : (
                    <Badge tone="neutral">inactive</Badge>
                  )}
                </div>
              </Td>
              <Td align="right" mono>
                {p.finds}
              </Td>
              <Td align="right" mono>
                {formatMon(p.creditBalanceWei)}
              </Td>
              <Td mono>{timestamp(p.createdAt)}</Td>
              <Td>
                <SuspendControl
                  playerId={p.id}
                  suspended={p.suspendedAt !== null}
                  canOperate={canOperate}
                  compact
                />
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <Pager
        page={page.page}
        take={page.take}
        total={total}
        hrefFor={(p) => pageHref("/admin/players", sp, p)}
      />
    </Panel>
  );
}
