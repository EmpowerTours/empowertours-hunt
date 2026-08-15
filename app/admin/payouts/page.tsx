// Payout review queue — the money screen.
//
// Server component: the rows and all their context are assembled here and
// handed to a client boundary that only adds selection state and the action
// forms. Every action it can fire is authorised again on the server.

import { AdminRole, PayoutStatus } from "@prisma/client";
import { requireAdminPage, roleAtLeast } from "@/lib/admin/auth";
import { listPayoutReview, payoutStatusCounts } from "@/lib/admin/queries";
import { formatMon } from "@/lib/wei";
import { pageHref, parsePage, first } from "@/lib/admin/pagination";
import { timestamp } from "@/lib/admin/format";
import { Danger, Pager, Panel, Warning } from "@/app/admin/_components/ui";
import {
  PayoutQueue,
  type QueueRow,
} from "@/app/admin/_components/PayoutQueue";

export const dynamic = "force-dynamic";

const VIEWS: Record<string, { label: string; statuses: PayoutStatus[] }> = {
  pending: { label: "Pending", statuses: [PayoutStatus.PENDING] },
  approved: { label: "Approved", statuses: [PayoutStatus.APPROVED] },
  attention: {
    label: "Needs attention",
    statuses: [
      PayoutStatus.NEEDS_RECONCILIATION,
      PayoutStatus.FAILED,
      PayoutStatus.SENDING,
    ],
  },
  sent: { label: "Sent", statuses: [PayoutStatus.SENT] },
  voided: { label: "Voided", statuses: [PayoutStatus.VOIDED] },
  all: {
    label: "All",
    statuses: [
      PayoutStatus.PENDING,
      PayoutStatus.APPROVED,
      PayoutStatus.SENDING,
      PayoutStatus.SENT,
      PayoutStatus.FAILED,
      PayoutStatus.NEEDS_RECONCILIATION,
      PayoutStatus.VOIDED,
    ],
  },
};

export default async function PayoutsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireAdminPage(AdminRole.VIEWER);
  const sp = await searchParams;
  const page = parsePage(sp, 25);

  const viewKey = first(sp.view) ?? "pending";
  const view = VIEWS[viewKey] ?? VIEWS.pending;
  const huntId = first(sp.huntId);

  const [{ rows, total }, counts] = await Promise.all([
    listPayoutReview({ statuses: view.statuses, huntId, page }),
    payoutStatusCounts(),
  ]);

  const canOperate = roleAtLeast(session.role, AdminRole.OPERATOR);

  const queueRows: QueueRow[] = rows.map((r) => ({
    id: r.id,
    status: r.status,
    amountWei: r.amountWei.toString(),
    amountMon: `${formatMon(r.amountWei)} MON`,
    autoApproved: r.autoApproved,
    approvedBy: r.approvedBy,
    approvedAt: r.approvedAt ? timestamp(r.approvedAt) : null,
    createdAt: timestamp(r.createdAt),
    txHash: r.txHash,
    failReason: r.failReason,
    voidReason: r.voidReason,
    reconciledBy: r.reconciledBy,
    huntName: r.hunt.name,
    huntId: r.hunt.id,
    spawn: {
      id: r.spawn.id,
      lat: r.spawn.lat,
      lng: r.spawn.lng,
      radiusMeters: r.spawn.radiusMeters,
      createdAt: timestamp(r.spawn.createdAt),
      expiresAt: timestamp(r.spawn.expiresAt),
      collectedAt: r.spawn.collectedAt ? timestamp(r.spawn.collectedAt) : null,
      seedCommit: r.spawn.seedCommit,
      seedReveal: r.spawn.seedReveal,
    },
    player: {
      id: r.player.id,
      walletAddress: r.player.walletAddress,
      turboUsername: r.player.turboUsername,
      displayName: r.player.displayName,
      suspended: r.player.suspendedAt !== null,
      active: r.player.active,
      createdAt: timestamp(r.player.createdAt),
    },
    attempt: r.attempt
      ? {
          id: r.attempt.id,
          attemptedAt: timestamp(r.attempt.attemptedAt),
          clientTs: timestamp(r.attempt.clientTs),
          accuracyM: r.attempt.accuracyM,
          accepted: r.attempt.accepted,
          flagged: r.attempt.flagged,
          reason: r.attempt.reason,
          lat: r.attempt.lat,
          lng: r.attempt.lng,
        }
      : null,
    previousFindAt: r.previousFindAt ? timestamp(r.previousFindAt) : null,
    distanceSincePreviousFindM: r.distanceSincePreviousFindM,
    speedKmhSincePreviousFind: r.speedKmhSincePreviousFind,
    maxSpeedKmh: r.hunt.maxSpeedKmh,
    maxAccuracyM: r.hunt.maxAccuracyM,
    history: {
      findsInHunt: r.history.findsInHunt,
      collectedMonInHunt: `${formatMon(r.history.collectedMonWeiInHunt)} MON`,
      flaggedAttempts30d: r.history.flaggedAttempts30d,
      payoutsSent: r.history.payoutsSent,
      payoutsVoided: r.history.payoutsVoided,
    },
  }));

  const autoOnPage = queueRows.filter((r) => r.autoApproved).length;

  return (
    <div className="flex flex-col gap-3">
      {counts.NEEDS_RECONCILIATION > 0 && (
        <Danger>
          <strong>{counts.NEEDS_RECONCILIATION}</strong> payout
          {counts.NEEDS_RECONCILIATION === 1 ? " is" : "s are"} in
          NEEDS_RECONCILIATION. Each one was broadcast to Monad and its outcome
          is unknown. They cannot be re-sent — resolve each against the chain
          before anything else in this queue.{" "}
          <a className="underline" href="/admin/payouts?view=attention">
            Open them
          </a>
        </Danger>
      )}

      {!canOperate && (
        <Warning>
          You are signed in as VIEWER. You can read this queue but not release,
          void or reconcile anything.
        </Warning>
      )}

      <nav className="flex flex-wrap gap-1 text-xs">
        {Object.entries(VIEWS).map(([key, v]) => {
          const n = v.statuses.reduce((sum, s) => sum + counts[s], 0);
          const activeView = key === viewKey;
          return (
            <a
              key={key}
              href={`/admin/payouts?view=${key}${huntId ? `&huntId=${huntId}` : ""}`}
              className={`rounded border px-2 py-1 ${
                activeView
                  ? "border-slate-500 bg-slate-800 text-slate-100"
                  : "border-slate-800 text-slate-400 hover:bg-slate-900"
              }`}
            >
              {v.label}{" "}
              <span className="font-mono tabular-nums text-slate-500">{n}</span>
            </a>
          );
        })}
      </nav>

      <Panel
        title={`${view.label} payouts`}
        subtitle={
          autoOnPage > 0
            ? `${autoOnPage} of the ${queueRows.length} rows on this page were auto-approved — released by policy, with no human looking at them. The treasury screen tracks that total against the hunt's rolling 24h cap.`
            : "Every row here pays real native MON on Monad mainnet. Approving is reversible until it is broadcast; broadcasting is not reversible at all."
        }
      >
        <PayoutQueue rows={queueRows} canOperate={canOperate} />
        <Pager
          page={page.page}
          take={page.take}
          total={total}
          hrefFor={(p) => pageHref("/admin/payouts", sp, p)}
        />
      </Panel>
    </div>
  );
}
