// Abuse review.
//
// Two signals, from the two tables that record probing:
//
//   ClaimAttempt.flagged  the verifier's own judgement that a rejection looked
//                         like tampering rather than a near miss.
//   HintRequest patterns  the quieter one. A quantized distance oracle is
//                         still an oracle: walk its band boundaries from three
//                         directions and the cache position falls out. Someone
//                         genuinely searching probes a handful of times and
//                         then finds it; someone trilaterating probes dozens of
//                         times across a wide area and never finds anything.
//
// Attempt coordinates are the PLAYER's self-reported position, not a cache
// position, so they are safe to show here. No cache coordinate appears on this
// screen.

import { AdminRole } from "@prisma/client";
import { requireAdminPage, roleAtLeast } from "@/lib/admin/auth";
import { hintProbePatterns, listFlaggedAttempts } from "@/lib/admin/queries";
import { pageHref, parsePage, first } from "@/lib/admin/pagination";
import { meters, relative, shortAddress, timestamp } from "@/lib/admin/format";
import { SuspendControl } from "@/app/admin/_components/SuspendControl";
import {
  Badge,
  Explain,
  Pager,
  Panel,
  Table,
  Td,
  Th,
  Warning,
} from "@/app/admin/_components/ui";

export const dynamic = "force-dynamic";

export default async function AbusePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireAdminPage(AdminRole.VIEWER);
  const sp = await searchParams;
  const page = parsePage(sp, 50);
  const huntId = first(sp.huntId);
  const canOperate = roleAtLeast(session.role, AdminRole.OPERATOR);

  const [{ rows: attempts, total }, patterns] = await Promise.all([
    listFlaggedAttempts({ page, huntId }),
    hintProbePatterns({ windowDays: 7, minProbes: 20, limit: 25 }),
  ]);

  return (
    <div className="flex flex-col gap-3">
      {!canOperate && (
        <Warning>
          VIEWER: you can read these signals but cannot suspend anyone.
        </Warning>
      )}

      <Panel
        title="Flagged claim attempts"
        subtitle="Rejections the verifier marked as suspicious rather than unlucky. A flagged attempt also blocks auto-approval of any payout it would have produced."
      >
        <Table>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Player</Th>
              <Th>Hunt</Th>
              <Th>Kind</Th>
              <Th>Reason</Th>
              <Th align="right">Accuracy</Th>
              <Th>Reported position</Th>
              <Th>Clock skew</Th>
              <Th>Action</Th>
            </tr>
          </thead>
          <tbody>
            {attempts.length === 0 && (
              <tr>
                <td
                  colSpan={9}
                  className="px-2 py-6 text-center text-xs text-slate-600"
                >
                  Nothing flagged.
                </td>
              </tr>
            )}
            {attempts.map((a) => {
              const skewSeconds = Math.round(
                (a.clientTs.getTime() - a.attemptedAt.getTime()) / 1000,
              );
              return (
                <tr
                  key={a.id}
                  className={a.accepted ? "bg-amber-950/20" : undefined}
                >
                  <Td mono>
                    <span title={timestamp(a.attemptedAt)}>
                      {relative(a.attemptedAt)}
                    </span>
                  </Td>
                  <Td>
                    <a
                      className="font-mono text-slate-200 underline decoration-slate-700 hover:decoration-slate-400"
                      href={`/admin/players/${a.player.id}`}
                    >
                      {shortAddress(a.player.walletAddress)}
                    </a>
                    {a.player.suspendedAt && (
                      <div className="mt-0.5">
                        <Badge tone="bad">suspended</Badge>
                      </div>
                    )}
                  </Td>
                  <Td>{a.hunt.name}</Td>
                  <Td>
                    <Badge tone={a.kind === "spawn" ? "warn" : "neutral"}>
                      {a.kind}
                    </Badge>
                  </Td>
                  <Td>
                    <div className="text-slate-300">{a.reason ?? "—"}</div>
                    {a.detail && (
                      <div className="text-[10px] text-slate-500">
                        {a.detail}
                      </div>
                    )}
                    {a.accepted && (
                      <Badge
                        tone="bad"
                        title="Flagged but accepted — worth a look."
                      >
                        accepted anyway
                      </Badge>
                    )}
                  </Td>
                  <Td align="right" mono>
                    {meters(a.accuracyM)}
                  </Td>
                  <Td mono>
                    {a.lat.toFixed(5)}, {a.lng.toFixed(5)}
                  </Td>
                  <Td mono>
                    <span
                      className={
                        Math.abs(skewSeconds) > 120
                          ? "text-amber-300"
                          : undefined
                      }
                    >
                      {skewSeconds > 0 ? "+" : ""}
                      {skewSeconds}s
                    </span>
                  </Td>
                  <Td>
                    <SuspendControl
                      playerId={a.player.id}
                      suspended={a.player.suspendedAt !== null}
                      canOperate={canOperate}
                      compact
                    />
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        <Pager
          page={page.page}
          take={page.take}
          total={total}
          hrefFor={(p) => pageHref("/admin/abuse", sp, p)}
        />
        <Explain>
          <strong>Clock skew</strong> is the player&apos;s claimed timestamp
          minus when the server received it. A large, consistent skew is a sign
          of a replayed or hand-crafted request rather than a phone with a bad
          clock.
        </Explain>
      </Panel>

      <Panel
        title="Hint probe patterns (last 7 days)"
        subtitle="Players with 20 or more hint requests in the window, ranked by volume. High probe counts spread over a wide area with no finds is the trilateration signature."
      >
        <Table>
          <thead>
            <tr>
              <Th>Player</Th>
              <Th align="right">Probes</Th>
              <Th align="right">Finds</Th>
              <Th align="right">Probes per find</Th>
              <Th align="right">Area covered</Th>
              <Th>Window</Th>
              <Th>Action</Th>
            </tr>
          </thead>
          <tbody>
            {patterns.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-2 py-6 text-center text-xs text-slate-600"
                >
                  No player has probed enough in the last 7 days to stand out.
                </td>
              </tr>
            )}
            {patterns.map((p) => {
              const noFinds = p.finds === 0;
              const wide = p.spreadM !== null && p.spreadM > 500;
              return (
                <tr
                  key={p.playerId}
                  className={noFinds && wide ? "bg-red-950/30" : undefined}
                >
                  <Td>
                    <a
                      className="font-mono text-slate-200 underline decoration-slate-700 hover:decoration-slate-400"
                      href={`/admin/players/${p.playerId}`}
                    >
                      {shortAddress(p.walletAddress)}
                    </a>
                    {p.turboUsername && (
                      <div className="text-[10px] text-slate-500">
                        @{p.turboUsername}
                      </div>
                    )}
                    {p.suspendedAt && (
                      <div className="mt-0.5">
                        <Badge tone="bad">suspended</Badge>
                      </div>
                    )}
                  </Td>
                  <Td align="right" mono>
                    {p.probes}
                  </Td>
                  <Td align="right" mono>
                    <span className={noFinds ? "text-red-300" : undefined}>
                      {p.finds}
                    </span>
                  </Td>
                  <Td align="right" mono>
                    {p.probesPerFind === null ? (
                      <span
                        className="text-red-300"
                        title="No finds at all in the window."
                      >
                        ∞
                      </span>
                    ) : (
                      p.probesPerFind.toFixed(1)
                    )}
                  </Td>
                  <Td align="right" mono>
                    <span className={wide ? "text-amber-300" : undefined}>
                      {p.spreadM === null ? "—" : `${p.spreadM.toFixed(0)} m`}
                    </span>
                  </Td>
                  <Td mono>
                    {p.firstProbeAt ? relative(p.firstProbeAt) : "—"} →{" "}
                    {p.lastProbeAt ? relative(p.lastProbeAt) : "—"}
                  </Td>
                  <Td>
                    <SuspendControl
                      playerId={p.playerId}
                      suspended={p.suspendedAt !== null}
                      canOperate={canOperate}
                      compact
                    />
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        <Explain>
          <strong>Area covered</strong> is the diagonal of the bounding box
          around their probes. A searcher works a small area and converges; a
          trilaterator samples widely and never converges, because they are
          measuring the oracle rather than looking for the cache.
        </Explain>
      </Panel>
    </div>
  );
}
