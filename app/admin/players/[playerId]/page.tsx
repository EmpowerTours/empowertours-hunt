// Player detail — everything one wallet has done, in one place.
//
// Cache LABELS appear in the finds table (they are a post-find reveal the
// player has already seen). Cache COORDINATES do not, and are not selected by
// the query behind this page.

import { notFound } from "next/navigation";
import { AdminRole } from "@prisma/client";
import { requireAdminPage, roleAtLeast } from "@/lib/admin/auth";
import { playerDetail } from "@/lib/admin/queries";
import { formatMon } from "@/lib/wei";
import { kmh, meters, relative, timestamp } from "@/lib/admin/format";
import { SuspendControl } from "@/app/admin/_components/SuspendControl";
import { CreditAdjust } from "@/app/admin/_components/CreditAdjust";
import {
  Badge,
  KeyVal,
  Panel,
  Stat,
  Table,
  Td,
  Th,
  Warning,
} from "@/app/admin/_components/ui";

export const dynamic = "force-dynamic";

const PAYOUT_TONE: Record<
  string,
  "neutral" | "good" | "warn" | "bad" | "alarm"
> = {
  PENDING: "warn",
  APPROVED: "good",
  SENDING: "warn",
  SENT: "good",
  FAILED: "bad",
  NEEDS_RECONCILIATION: "alarm",
  VOIDED: "neutral",
};

export default async function PlayerDetailPage({
  params,
}: {
  params: Promise<{ playerId: string }>;
}) {
  const session = await requireAdminPage(AdminRole.VIEWER);
  const { playerId } = await params;
  const canOperate = roleAtLeast(session.role, AdminRole.OPERATOR);

  const detail = await playerDetail(playerId);
  if (!detail) notFound();

  const {
    player,
    finds,
    credits,
    payouts,
    attempts,
    huntStats,
    attemptTotals,
  } = detail;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-sm text-slate-100">
          {player.walletAddress}
        </h1>
        {player.suspendedAt ? (
          <Badge tone="bad">suspended {relative(player.suspendedAt)}</Badge>
        ) : player.active ? (
          <Badge tone="good">active</Badge>
        ) : (
          <Badge tone="neutral">inactive</Badge>
        )}
        <SuspendControl
          playerId={player.id}
          suspended={player.suspendedAt !== null}
          canOperate={canOperate}
        />
      </div>

      {player.suspendReason && (
        <Warning>Suspension reason on file: {player.suspendReason}</Warning>
      )}

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="TURBO credit"
          value={`${formatMon(player.creditBalanceWei)} WMON`}
          hint="Balance cached on the Player row; the ledger below is the source of truth."
        />
        <Stat
          label="Attempts"
          value={`${attemptTotals.accepted} / ${attemptTotals.accepted + attemptTotals.rejected}`}
          hint="Accepted out of total."
        />
        <Stat
          label="Flagged attempts"
          value={String(attemptTotals.flagged)}
          tone={attemptTotals.flagged > 0 ? "warn" : "neutral"}
          hint="A flagged attempt blocks auto-approval of any payout it would have produced."
        />
        <Stat
          label="TURBO identity"
          value={player.turboUsername ? `@${player.turboUsername}` : "unlinked"}
          hint={
            player.turboUsername
              ? "Credit can be redeemed against their cohort subscription."
              : "No builder identity linked, so credit has nothing to redeem against yet."
          }
        />
      </div>

      <Panel title="Identity">
        <KeyVal k="player id" v={player.id} />
        <KeyVal k="wallet" v={player.walletAddress} />
        <KeyVal k="display name" v={player.displayName ?? "—"} />
        <KeyVal
          k="onboarded via"
          v={
            player.passkeyCredentialId
              ? "Mera passkey"
              : "injected wallet / Privy"
          }
        />
        <KeyVal k="joined" v={timestamp(player.createdAt)} />
        {player.turboUsername && (
          <KeyVal
            k="turbo"
            v={
              <a
                className="underline decoration-slate-700 hover:decoration-slate-400"
                href={`https://github.com/${player.turboUsername}`}
                rel="noreferrer noopener"
                target="_blank"
              >
                @{player.turboUsername}
              </a>
            }
          />
        )}
      </Panel>

      <Panel title="Per-hunt totals">
        <Table>
          <thead>
            <tr>
              <Th>Hunt</Th>
              <Th align="right">Finds</Th>
              <Th align="right">Credit earned</Th>
              <Th align="right">MON collected</Th>
              <Th>Last verified position</Th>
              <Th>Last spawn</Th>
            </tr>
          </thead>
          <tbody>
            {huntStats.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-2 py-6 text-center text-xs text-slate-600"
                >
                  No activity in any hunt.
                </td>
              </tr>
            )}
            {huntStats.map((s) => (
              <tr key={s.huntId}>
                <Td>{s.hunt.name}</Td>
                <Td align="right" mono>
                  {s.findCount}
                </Td>
                <Td align="right" mono>
                  {formatMon(s.earnedCredit)} WMON
                </Td>
                <Td align="right" mono>
                  {formatMon(s.collectedMon)} MON
                </Td>
                <Td mono>{timestamp(s.lastVerifiedAt)}</Td>
                <Td mono>{timestamp(s.lastSpawnAt)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Panel>

      <Panel
        title="Payouts"
        subtitle="Most recent 50. NEEDS_RECONCILIATION rows are resolved from the payout queue, never from here."
      >
        <Table>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Status</Th>
              <Th align="right">Amount</Th>
              <Th>Released by</Th>
              <Th>Tx</Th>
              <Th>Note</Th>
            </tr>
          </thead>
          <tbody>
            {payouts.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-2 py-6 text-center text-xs text-slate-600"
                >
                  No payouts.
                </td>
              </tr>
            )}
            {payouts.map((p) => (
              <tr key={p.id}>
                <Td mono>{timestamp(p.createdAt)}</Td>
                <Td>
                  <Badge tone={PAYOUT_TONE[p.status] ?? "neutral"}>
                    {p.status}
                  </Badge>
                </Td>
                <Td align="right" mono>
                  {formatMon(p.amountWei)} MON
                </Td>
                <Td>
                  {p.autoApproved ? (
                    <Badge
                      tone="warn"
                      title="Released by policy, no human involved."
                    >
                      auto
                    </Badge>
                  ) : (
                    <span className="font-mono text-[10px] text-slate-400">
                      {p.approvedBy ?? "—"}
                    </span>
                  )}
                </Td>
                <Td mono>
                  {p.txHash ? (
                    <a
                      className="underline decoration-slate-700 hover:decoration-slate-400"
                      href={`https://monadscan.com/tx/${p.txHash}`}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {p.txHash.slice(0, 10)}…
                    </a>
                  ) : (
                    "—"
                  )}
                </Td>
                <Td>{p.voidReason ?? p.failReason ?? "—"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Panel>

      <Panel
        title="Credit ledger"
        subtitle="Append-only. A correction is a new negative entry, never an edit."
        actions={canOperate ? undefined : undefined}
      >
        {canOperate && (
          <div className="mb-3 rounded border border-slate-800 bg-slate-900/60 p-3">
            <CreditAdjust playerId={player.id} />
          </div>
        )}
        <Table>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Reason</Th>
              <Th>Hunt</Th>
              <Th align="right">Amount</Th>
              <Th align="right">Balance after</Th>
              <Th>Note</Th>
              <Th>Actor</Th>
            </tr>
          </thead>
          <tbody>
            {credits.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-2 py-6 text-center text-xs text-slate-600"
                >
                  No credit entries.
                </td>
              </tr>
            )}
            {credits.map((c) => (
              <tr key={c.id}>
                <Td mono>{timestamp(c.createdAt)}</Td>
                <Td>
                  <Badge tone={c.amount < 0n ? "bad" : "good"}>
                    {c.reason}
                  </Badge>
                </Td>
                <Td>{c.hunt?.name ?? "—"}</Td>
                <Td align="right" mono>
                  <span
                    className={
                      c.amount < 0n ? "text-red-300" : "text-emerald-300"
                    }
                  >
                    {c.amount < 0n ? "-" : "+"}
                    {formatMon(c.amount < 0n ? -c.amount : c.amount)}
                  </span>
                </Td>
                <Td align="right" mono>
                  {formatMon(c.balanceAfter)}
                </Td>
                <Td>{c.note ?? "—"}</Td>
                <Td mono>{c.actorId ?? "system"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Panel>

      <Panel title="Finds" subtitle="Most recent 50.">
        <Table>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Hunt</Th>
              <Th>Cache</Th>
              <Th align="right">Distance</Th>
              <Th align="right">Accuracy</Th>
              <Th align="right">Speed from last</Th>
              <Th align="right">Credit</Th>
            </tr>
          </thead>
          <tbody>
            {finds.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-2 py-6 text-center text-xs text-slate-600"
                >
                  No finds.
                </td>
              </tr>
            )}
            {finds.map((f) => (
              <tr key={f.id}>
                <Td mono>{timestamp(f.foundAt)}</Td>
                <Td>{f.hunt.name}</Td>
                <Td>{f.cache.label ?? f.cache.id}</Td>
                <Td align="right" mono>
                  {meters(f.distanceMeters)}
                </Td>
                <Td align="right" mono>
                  {meters(f.accuracyM)}
                </Td>
                <Td align="right" mono>
                  {kmh(f.speedKmhFromLast)}
                </Td>
                <Td align="right" mono>
                  {formatMon(f.rewardCreditWei)} WMON
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Panel>

      <Panel
        title="Attempt history"
        subtitle="Most recent 50, accepted and rejected. Replaying these rows through the verifier is how a disputed claim is answered."
      >
        <Table>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Hunt</Th>
              <Th>Kind</Th>
              <Th>Outcome</Th>
              <Th align="right">Accuracy</Th>
              <Th>Reported position</Th>
            </tr>
          </thead>
          <tbody>
            {attempts.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-2 py-6 text-center text-xs text-slate-600"
                >
                  No attempts.
                </td>
              </tr>
            )}
            {attempts.map((a) => (
              <tr
                key={a.id}
                className={a.flagged ? "bg-amber-950/20" : undefined}
              >
                <Td mono>{timestamp(a.attemptedAt)}</Td>
                <Td>{a.hunt.name}</Td>
                <Td>{a.kind}</Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    <Badge tone={a.accepted ? "good" : "neutral"}>
                      {a.accepted ? "accepted" : (a.reason ?? "rejected")}
                    </Badge>
                    {a.flagged && <Badge tone="bad">flagged</Badge>}
                  </div>
                </Td>
                <Td align="right" mono>
                  {meters(a.accuracyM)}
                </Td>
                <Td mono>
                  {a.lat.toFixed(5)}, {a.lng.toFixed(5)}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Panel>
    </div>
  );
}
