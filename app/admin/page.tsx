// Treasury dashboard — can we cover what we owe?
//
// The single question this screen answers at a glance: does the hot wallet
// hold more MON than the sum of everything already earned but not yet sent.
// Everything else on the page is context for that number.
//
// In-flight payouts (SENDING, NEEDS_RECONCILIATION) are shown SEPARATELY and
// are not netted off the balance. Netting them would assume the money already
// left, which is exactly the thing nobody knows about a NEEDS_RECONCILIATION
// row.

import { AdminRole } from "@prisma/client";
import { requireAdminPage } from "@/lib/admin/auth";
import { treasurySnapshot } from "@/lib/admin/queries";
import { readTreasuryBalance } from "@/lib/admin/treasury";
import { formatMon } from "@/lib/wei";
import { pctOfWei } from "@/lib/admin/format";
import {
  Badge,
  Danger,
  Explain,
  Panel,
  Stat,
  Table,
  Td,
  Th,
  Warning,
} from "@/app/admin/_components/ui";

export const dynamic = "force-dynamic";

function Bar({
  used,
  total,
  tone,
}: {
  used: bigint;
  total: bigint;
  tone: "credit" | "mon";
}) {
  const pct = pctOfWei(used, total);
  const width = pct === null ? 0 : Math.min(100, Math.max(0, pct));
  const hot = pct !== null && pct >= 90;
  return (
    <div>
      <div className="h-1.5 w-full overflow-hidden rounded bg-slate-800">
        <div
          className={`h-full ${
            hot
              ? "bg-red-500"
              : tone === "mon"
                ? "bg-sky-500"
                : "bg-emerald-500"
          }`}
          style={{ width: `${width}%` }}
        />
      </div>
      <div className="mt-0.5 font-mono text-[10px] tabular-nums text-slate-500">
        {pct === null ? "no budget set" : `${pct.toFixed(1)}% consumed`}
      </div>
    </div>
  );
}

export default async function TreasuryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminPage(AdminRole.VIEWER);
  const sp = await searchParams;

  const [snapshot, balance] = await Promise.all([
    treasurySnapshot(),
    readTreasuryBalance(),
  ]);

  const owed = snapshot.pendingWei + snapshot.approvedWei;
  const worstCase = owed + snapshot.inFlightWei;
  const covered =
    balance.balanceWei === null ? null : balance.balanceWei >= owed;
  const coversWorstCase =
    balance.balanceWei === null ? null : balance.balanceWei >= worstCase;

  return (
    <div className="flex flex-col gap-3">
      {sp.denied && (
        <Warning>
          That screen needs a higher role than yours. Nothing was changed.
        </Warning>
      )}

      {snapshot.needsReconciliationCount > 0 && (
        <Danger>
          <strong>{snapshot.needsReconciliationCount}</strong> payout
          {snapshot.needsReconciliationCount === 1 ? "" : "s"} broadcast with an
          unknown outcome. Until each is resolved against the chain the real
          treasury balance is uncertain by up to{" "}
          <span className="font-mono">
            {formatMon(snapshot.inFlightWei)} MON
          </span>
          .{" "}
          <a className="underline" href="/admin/payouts?view=attention">
            Resolve them
          </a>
        </Danger>
      )}

      {covered === false && (
        <Danger>
          The treasury cannot cover what it already owes. Approving anything
          further will produce failed sends. Fund the hot wallet, or void what
          should not be paid.
        </Danger>
      )}

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Treasury balance"
          value={
            balance.balanceWei === null
              ? "unavailable"
              : `${formatMon(balance.balanceWei)} MON`
          }
          hint={balance.address ?? balance.error ?? undefined}
          tone={balance.balanceWei === null ? "warn" : "neutral"}
        />
        <Stat
          label="Owed (pending + approved)"
          value={`${formatMon(owed)} MON`}
          hint={`${snapshot.pendingCount} pending · ${snapshot.approvedCount} approved`}
          tone={covered === false ? "bad" : "neutral"}
        />
        <Stat
          label="Coverage"
          value={
            covered === null
              ? "unknown"
              : covered
                ? coversWorstCase
                  ? "covered"
                  : "covered (excl. in-flight)"
                : "SHORT"
          }
          hint="Balance measured against everything earned but not yet broadcast. In-flight payouts are not netted off."
          tone={covered === null ? "warn" : covered ? "good" : "bad"}
        />
        <Stat
          label="In flight / unresolved"
          value={`${formatMon(snapshot.inFlightWei)} MON`}
          hint={`${snapshot.inFlightCount} rows · ${snapshot.needsReconciliationCount} need reconciliation`}
          tone={snapshot.inFlightCount > 0 ? "warn" : "neutral"}
        />
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Sent, last 24h"
          value={`${formatMon(snapshot.sent24hWei)} MON`}
          hint="Confirmed on chain."
        />
        <Stat
          label="Auto-approved, last 24h"
          value={`${formatMon(snapshot.autoApproved24hWei)} MON`}
          hint="Released by policy with no human in the loop. Compare against each hunt's rolling 24h cap below."
          tone={snapshot.autoApproved24hWei > 0n ? "warn" : "neutral"}
        />
        <Stat
          label="Auto-approved, all time"
          value={`${formatMon(snapshot.autoApprovedAllTimeWei)} MON`}
          hint="How much has ever moved without a human looking at it."
        />
        <Stat
          label="TURBO credit outstanding"
          value={`${formatMon(snapshot.creditOutstandingWei)} WMON`}
          hint={`${formatMon(snapshot.creditIssuedWei)} WMON issued in total. Credit is a subscription discount, not cash — it costs margin only when someone joins.`}
        />
      </div>

      <Panel
        title="Per-hunt budgets"
        subtitle="Budgets are ceilings enforced by an atomic conditional UPDATE at spend time, not by this screen. A bar at 100% means further claims are refused, not overspent."
      >
        <Table>
          <thead>
            <tr>
              <Th>Hunt</Th>
              <Th>State</Th>
              <Th align="right">MON budget</Th>
              <Th>MON consumed</Th>
              <Th align="right">Credit budget</Th>
              <Th>Credit consumed</Th>
              <Th align="right">Auto-approve cap</Th>
              <Th>Auto-approved 24h</Th>
            </tr>
          </thead>
          <tbody>
            {snapshot.hunts.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="px-2 py-6 text-center text-xs text-slate-600"
                >
                  No hunts yet.
                </td>
              </tr>
            )}
            {snapshot.hunts.map((h) => {
              const autoPct = pctOfWei(
                h.autoApproved24hWei,
                h.autoApproveDailyCapWei,
              );
              return (
                <tr key={h.id}>
                  <Td>
                    <a
                      className="text-slate-200 underline decoration-slate-700 hover:decoration-slate-400"
                      href={`/admin/hunts/${h.id}`}
                    >
                      {h.name}
                    </a>
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
                    {formatMon(h.budgetMonWei)}
                  </Td>
                  <Td>
                    <div className="min-w-32">
                      <div className="font-mono text-[10px] tabular-nums text-slate-400">
                        {formatMon(h.spentMonWei)} MON
                      </div>
                      <Bar
                        used={h.spentMonWei}
                        total={h.budgetMonWei}
                        tone="mon"
                      />
                    </div>
                  </Td>
                  <Td align="right" mono>
                    {formatMon(h.budgetCreditWei)}
                  </Td>
                  <Td>
                    <div className="min-w-32">
                      <div className="font-mono text-[10px] tabular-nums text-slate-400">
                        {formatMon(h.spentCreditWei)} WMON
                      </div>
                      <Bar
                        used={h.spentCreditWei}
                        total={h.budgetCreditWei}
                        tone="credit"
                      />
                    </div>
                  </Td>
                  <Td align="right" mono>
                    {h.autoApproveMaxWei === 0n ? (
                      <span className="text-emerald-400">off</span>
                    ) : (
                      `≤ ${formatMon(h.autoApproveMaxWei)}`
                    )}
                  </Td>
                  <Td>
                    <div className="min-w-32">
                      <div
                        className={`font-mono text-[10px] tabular-nums ${
                          autoPct !== null && autoPct >= 90
                            ? "text-red-300"
                            : "text-slate-400"
                        }`}
                      >
                        {formatMon(h.autoApproved24hWei)} /{" "}
                        {formatMon(h.autoApproveDailyCapWei)} MON
                      </div>
                      <Bar
                        used={h.autoApproved24hWei}
                        total={h.autoApproveDailyCapWei}
                        tone="mon"
                      />
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        <Explain>
          <strong>Auto-approve cap</strong> is the largest single payout that
          may be released without a person. <strong>Auto-approved 24h</strong>{" "}
          is what policy has released across the whole hunt in a rolling day —
          once it exceeds the cap, everything falls back to PENDING until a
          human intervenes. A payout whose claim attempt was flagged never
          auto-approves regardless of either number.
        </Explain>
      </Panel>
    </div>
  );
}
