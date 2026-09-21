// Redemption queue — what the cohort owes players, and the button that pays it.
//
// A redemption is a DEBT. Credit is already debited, atomically, when the
// player redeems; the months are owed from that moment. Before this page there
// was no surface at all: a PENDING row was invisible, so a player who redeemed
// simply never received what they paid for and nobody could have known.
//
// Oldest first, deliberately — the longest-outstanding debt is the one most
// likely to have been forgotten.

import { AdminRole, RedemptionStatus } from "@prisma/client";
import { requireAdminPage, roleAtLeast } from "@/lib/admin/auth";
import {
  listRedemptionReview,
  redemptionStatusCounts,
} from "@/lib/admin/queries";
import { pageHref, parsePage, first } from "@/lib/admin/pagination";
import { timestamp, weiOf } from "@/lib/admin/format";
import { formatMon } from "@/lib/wei";
import { Pager, Panel, Warning } from "@/app/admin/_components/ui";
import { SettleRedemption } from "@/app/admin/_components/SettleRedemption";

export const dynamic = "force-dynamic";

const VIEWS: Record<string, { label: string; statuses: RedemptionStatus[] }> = {
  pending: { label: "pending", statuses: ["PENDING"] },
  settled: { label: "settled", statuses: ["SETTLED"] },
  voided: { label: "voided", statuses: ["VOIDED"] },
  all: { label: "all", statuses: ["PENDING", "SETTLED", "VOIDED"] },
};

export default async function RedemptionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireAdminPage(AdminRole.VIEWER);
  const sp = await searchParams;
  const page = parsePage(sp, 25);
  const viewKey = first(sp.view) ?? "pending";
  const view = VIEWS[viewKey] ?? VIEWS.pending;

  const [{ rows, total }, counts] = await Promise.all([
    listRedemptionReview({ statuses: view.statuses, page }),
    redemptionStatusCounts(),
  ]);

  const canOperate = roleAtLeast(session.role, AdminRole.OPERATOR);

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Redemptions"
        subtitle="TURBO credit spent on cohort months. Credit is already debited — these are months owed."
        actions={
          <nav className="flex flex-wrap gap-2 text-[11px]">
            {Object.entries(VIEWS).map(([key, v]) => (
              <a
                key={key}
                href={`/admin/redemptions?view=${key}`}
                className={
                  key === viewKey
                    ? "rounded bg-slate-100 px-2 py-1 font-semibold text-slate-900"
                    : "rounded border border-slate-700 px-2 py-1 text-slate-300"
                }
              >
                {v.label}
                {v.statuses.length === 1
                  ? ` (${counts[v.statuses[0]] ?? 0})`
                  : ""}
              </a>
            ))}
          </nav>
        }
      >
        {counts.PENDING > 0 && viewKey !== "pending" && (
          <div className="px-3 pt-3">
            <Warning>
              {counts.PENDING} redemption{counts.PENDING === 1 ? " is" : "s are"}{" "}
              still owed. Credit for {counts.PENDING === 1 ? "it" : "them"} has
              already been spent.
            </Warning>
          </div>
        )}

        {rows.length === 0 ? (
          <p className="px-3 py-6 text-xs text-slate-500">
            Nothing {view.label === "all" ? "recorded" : view.label}.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-3 py-2">redeemed</th>
                  <th className="px-3 py-2">player</th>
                  <th className="px-3 py-2">owed</th>
                  <th className="px-3 py-2">credit spent</th>
                  <th className="px-3 py-2">status</th>
                  <th className="px-3 py-2">action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-slate-800/60">
                    <td className="px-3 py-2 text-slate-400">
                      {timestamp(r.createdAt)}
                    </td>
                    <td className="px-3 py-2">
                      <a
                        href={`/admin/players/${r.player.id}`}
                        className="font-mono text-slate-200 underline decoration-slate-700"
                      >
                        {r.player.walletAddress.slice(0, 6)}…
                        {r.player.walletAddress.slice(-4)}
                      </a>
                      {r.player.turboUsername && (
                        <span className="ml-2 text-slate-500">
                          {r.player.turboUsername}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-200">
                      {r.months} × {r.tier}
                    </td>
                    <td className="px-3 py-2 font-mono text-slate-300">
                      {formatMon(weiOf(r.costCreditWei))}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          r.status === "PENDING"
                            ? "text-amber-300"
                            : r.status === "SETTLED"
                              ? "text-emerald-300"
                              : "text-slate-500"
                        }
                      >
                        {r.status.toLowerCase()}
                      </span>
                      {r.status === "SETTLED" && r.settlementNote && (
                        <div className="mt-1 max-w-72 truncate font-mono text-[10px] text-slate-500">
                          {r.settlementNote}
                        </div>
                      )}
                      {r.status === "VOIDED" && r.voidReason && (
                        <div className="mt-1 text-[10px] text-slate-500">
                          {r.voidReason}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {r.status === "PENDING" ? (
                        <SettleRedemption
                          redemptionId={r.id}
                          months={r.months}
                          tier={r.tier}
                          disabled={!canOperate}
                        />
                      ) : r.settledAt ? (
                        <span className="text-[11px] text-slate-500">
                          {timestamp(r.settledAt)}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="px-3 py-2">
          <Pager
            page={page.page}
            take={page.take}
            total={total}
            hrefFor={(n) => pageHref("/admin/redemptions", sp, n)}
          />
        </div>
      </Panel>

      <p className="text-[11px] leading-relaxed text-slate-500">
        Settling wraps the settler&apos;s WMON shortfall, approves the cohort for
        an exact amount, then calls payMonthlyFor. The cohort credits one month
        per call and refuses another payment for the same member for 25 days, so
        a settlement cannot simply be repeated if it goes wrong — a broadcast
        whose receipt never arrived is left PENDING and flagged for
        reconciliation rather than retried.
      </p>
    </div>
  );
}
