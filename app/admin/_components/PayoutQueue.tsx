"use client";

// The money screen.
//
// A client boundary because the queue needs selection state and inline action
// forms. Everything it acts on is re-checked server-side: the role, the legal
// transition, and the batch total. Hiding a button here is presentation, not
// protection.
//
// The one rule encoded in the affordances themselves: NEEDS_RECONCILIATION
// gets no Approve and no Send. That status means a transaction was broadcast
// and its outcome is unknown, so "retry" would be a second transfer of real
// MON. It gets a reconciliation form and an alarming colour instead.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { adminPost } from "@/app/admin/_components/api";
import { Badge } from "@/app/admin/_components/ui";

export interface QueueRow {
  id: string;
  status: string;
  amountWei: string;
  amountMon: string;
  autoApproved: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  txHash: string | null;
  failReason: string | null;
  voidReason: string | null;
  reconciledBy: string | null;
  huntName: string;
  huntId: string;
  spawn: {
    id: string;
    lat: number;
    lng: number;
    radiusMeters: number;
    createdAt: string;
    expiresAt: string;
    collectedAt: string | null;
    seedCommit: string;
    seedReveal: string | null;
  };
  player: {
    id: string;
    walletAddress: string;
    turboUsername: string | null;
    displayName: string | null;
    suspended: boolean;
    active: boolean;
    createdAt: string;
  };
  attempt: {
    id: string;
    attemptedAt: string;
    clientTs: string;
    accuracyM: number | null;
    accepted: boolean;
    flagged: boolean;
    reason: string | null;
    lat: number;
    lng: number;
  } | null;
  previousFindAt: string | null;
  distanceSincePreviousFindM: number | null;
  speedKmhSincePreviousFind: number | null;
  maxSpeedKmh: number;
  maxAccuracyM: number;
  history: {
    findsInHunt: number;
    collectedMonInHunt: string;
    flaggedAttempts30d: number;
    payoutsSent: number;
    payoutsVoided: number;
  };
}

const STATUS_TONE: Record<
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

function isBatchEligible(r: QueueRow): boolean {
  return r.status === "PENDING" || (r.status === "FAILED" && !r.txHash);
}

/** Format a wei bigint for display without ever going through Number. */
function monFromWei(wei: bigint): string {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

export function PayoutQueue({
  rows,
  canOperate,
}: {
  rows: QueueRow[];
  canOperate: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const eligible = useMemo(() => rows.filter(isBatchEligible), [rows]);
  const selectedTotal = useMemo(() => {
    let total = 0n;
    for (const r of eligible)
      if (selected.has(r.id)) total += BigInt(r.amountWei);
    return total;
  }, [eligible, selected]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function run(
    key: string,
    path: string,
    body?: unknown,
  ): Promise<boolean> {
    setBusy(key);
    setError(null);
    setNotice(null);
    const res = await adminPost(path, body);
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return false;
    }
    setNotice("done");
    router.refresh();
    return true;
  }

  async function batchApprove() {
    const ids = eligible.filter((r) => selected.has(r.id)).map((r) => r.id);
    if (ids.length === 0) return;
    const ok = await run("batch", "/api/admin/payouts/batch-approve", {
      payoutIds: ids,
      // Echoed back so the server can refuse if the queue moved between render
      // and click.
      confirmTotalWei: selectedTotal.toString(),
    });
    if (ok) setSelected(new Set());
  }

  return (
    <div>
      {(error || notice) && (
        <div
          className={`mb-2 rounded border px-3 py-2 text-xs ${
            error
              ? "border-red-700 bg-red-950/60 text-red-200"
              : "border-emerald-800 bg-emerald-950/40 text-emerald-200"
          }`}
        >
          {error ?? notice}
        </div>
      )}

      {canOperate && eligible.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded border border-slate-800 bg-slate-900/60 px-3 py-2">
          <button
            type="button"
            onClick={() =>
              setSelected(
                selected.size === eligible.length
                  ? new Set()
                  : new Set(eligible.map((r) => r.id)),
              )
            }
            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
          >
            {selected.size === eligible.length
              ? "clear selection"
              : `select all ${eligible.length} on this page`}
          </button>
          <span className="font-mono text-xs tabular-nums text-slate-300">
            {selected.size} selected · {monFromWei(selectedTotal)} MON
          </span>
          <button
            type="button"
            disabled={selected.size === 0 || busy === "batch"}
            onClick={batchApprove}
            className="rounded bg-emerald-700 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
          >
            {busy === "batch"
              ? "approving…"
              : `Approve ${selected.size} → ${monFromWei(selectedTotal)} MON`}
          </button>
          <span className="text-[11px] text-slate-500">
            Approving releases these for broadcast. The total is re-checked
            server-side and the batch is refused if the queue changed.
          </span>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              {canOperate && <th className="w-6 border-b border-slate-800" />}
              <Th>Status</Th>
              <Th align="right">Amount</Th>
              <Th>Player</Th>
              <Th>Hunt / spawn</Th>
              <Th align="right">Accuracy</Th>
              <Th align="right">Speed since last find</Th>
              <Th>Signals</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={canOperate ? 9 : 8}
                  className="px-2 py-6 text-center text-slate-600"
                >
                  Nothing in this view.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const speedHot =
                r.speedKmhSincePreviousFind !== null &&
                r.speedKmhSincePreviousFind > r.maxSpeedKmh;
              const accuracyHot =
                r.attempt?.accuracyM !== null &&
                r.attempt?.accuracyM !== undefined &&
                r.attempt.accuracyM > r.maxAccuracyM;
              const needsRecon = r.status === "NEEDS_RECONCILIATION";

              return (
                <tr
                  key={r.id}
                  className={
                    needsRecon
                      ? "bg-red-950/40"
                      : r.attempt?.flagged
                        ? "bg-amber-950/20"
                        : undefined
                  }
                >
                  {canOperate && (
                    <Td>
                      {isBatchEligible(r) ? (
                        <input
                          type="checkbox"
                          checked={selected.has(r.id)}
                          onChange={() => toggle(r.id)}
                          aria-label={`select payout ${r.id}`}
                        />
                      ) : null}
                    </Td>
                  )}

                  <Td>
                    <div className="flex flex-col gap-1">
                      <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>
                        {r.status}
                      </Badge>
                      {r.autoApproved && (
                        <Badge
                          tone="warn"
                          title="Released by policy, not by a person. This is money that moved without a human looking at it."
                        >
                          auto
                        </Badge>
                      )}
                      <button
                        type="button"
                        onClick={() => toggleExpand(r.id)}
                        className="text-left text-[10px] text-slate-500 underline hover:text-slate-300"
                      >
                        {expanded.has(r.id) ? "less" : "details"}
                      </button>
                    </div>
                  </Td>

                  <Td align="right" mono>
                    {r.amountMon}
                  </Td>

                  <Td>
                    <a
                      href={`/admin/players/${r.player.id}`}
                      className="font-mono text-slate-200 underline decoration-slate-700 hover:decoration-slate-400"
                    >
                      {r.player.walletAddress.slice(0, 6)}…
                      {r.player.walletAddress.slice(-4)}
                    </a>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {r.player.turboUsername && (
                        <span className="text-[10px] text-slate-500">
                          @{r.player.turboUsername}
                        </span>
                      )}
                      {r.player.suspended && (
                        <Badge tone="bad">suspended</Badge>
                      )}
                      {!r.player.active && <Badge tone="bad">inactive</Badge>}
                    </div>
                  </Td>

                  <Td>
                    <div className="text-slate-300">{r.huntName}</div>
                    <div className="font-mono text-[10px] text-slate-500">
                      {r.spawn.lat.toFixed(5)}, {r.spawn.lng.toFixed(5)} ·{" "}
                      {r.spawn.radiusMeters}m
                    </div>
                  </Td>

                  <Td align="right" mono>
                    <span
                      className={accuracyHot ? "text-amber-300" : undefined}
                    >
                      {r.attempt?.accuracyM !== null &&
                      r.attempt?.accuracyM !== undefined
                        ? `${r.attempt.accuracyM.toFixed(1)} m`
                        : "—"}
                    </span>
                  </Td>

                  <Td align="right" mono>
                    <span className={speedHot ? "text-red-300" : undefined}>
                      {r.speedKmhSincePreviousFind !== null
                        ? `${r.speedKmhSincePreviousFind.toFixed(1)} km/h`
                        : "—"}
                    </span>
                    <div className="text-[10px] text-slate-600">
                      limit {r.maxSpeedKmh}
                    </div>
                  </Td>

                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {r.attempt?.flagged && <Badge tone="bad">flagged</Badge>}
                      {r.attempt === null && (
                        <Badge
                          tone="warn"
                          title="No collect attempt could be matched to this payout by time. Judge it on the spawn and the player's history."
                        >
                          no attempt
                        </Badge>
                      )}
                      {r.history.flaggedAttempts30d > 0 && (
                        <Badge tone="warn">
                          {r.history.flaggedAttempts30d} flagged/30d
                        </Badge>
                      )}
                      {r.history.payoutsVoided > 0 && (
                        <Badge tone="neutral">
                          {r.history.payoutsVoided} voided
                        </Badge>
                      )}
                    </div>
                  </Td>

                  <Td>
                    <RowActions
                      row={r}
                      canOperate={canOperate}
                      busy={busy}
                      run={run}
                    />
                  </Td>
                </tr>
              );
            })}

            {rows.flatMap((r) =>
              expanded.has(r.id)
                ? [
                    <tr key={`${r.id}-detail`} className="bg-slate-900/60">
                      <td colSpan={canOperate ? 9 : 8} className="px-3 py-3">
                        <RowDetail row={r} />
                      </td>
                    </tr>,
                  ]
                : [],
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({
  children,
  align = "left",
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={`border-b border-slate-800 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500 ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = "left",
  mono = false,
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
  mono?: boolean;
}) {
  return (
    <td
      className={`border-b border-slate-900 px-2 py-1.5 align-top ${
        align === "right" ? "text-right" : "text-left"
      } ${mono ? "font-mono tabular-nums" : ""}`}
    >
      {children}
    </td>
  );
}

function RowDetail({ row }: { row: QueueRow }) {
  const kv: Array<[string, string]> = [
    ["payout id", row.id],
    ["created", row.createdAt],
    ["approved by", row.approvedBy ?? "—"],
    ["approved at", row.approvedAt ?? "—"],
    ["tx hash", row.txHash ?? "—"],
    ["fail reason", row.failReason ?? "—"],
    ["void reason", row.voidReason ?? "—"],
    ["reconciled by", row.reconciledBy ?? "—"],
    ["spawn created", row.spawn.createdAt],
    ["spawn expires", row.spawn.expiresAt],
    ["spawn collected", row.spawn.collectedAt ?? "not collected"],
    ["seed commit", row.spawn.seedCommit],
    ["seed reveal", row.spawn.seedReveal ?? "—"],
    ["attempt at", row.attempt?.attemptedAt ?? "—"],
    ["attempt client clock", row.attempt?.clientTs ?? "—"],
    [
      "attempt position",
      row.attempt
        ? `${row.attempt.lat.toFixed(6)}, ${row.attempt.lng.toFixed(6)}`
        : "—",
    ],
    ["attempt accepted", row.attempt ? String(row.attempt.accepted) : "—"],
    ["attempt reason", row.attempt?.reason ?? "—"],
    ["previous find", row.previousFindAt ?? "no prior find"],
    [
      "distance since",
      row.distanceSincePreviousFindM !== null
        ? `${row.distanceSincePreviousFindM.toFixed(0)} m`
        : "—",
    ],
    ["finds in hunt", String(row.history.findsInHunt)],
    ["MON collected in hunt", row.history.collectedMonInHunt],
    ["payouts sent", String(row.history.payoutsSent)],
    ["player since", row.player.createdAt],
  ];

  return (
    <div className="grid gap-x-6 gap-y-0.5 md:grid-cols-2 lg:grid-cols-3">
      {kv.map(([k, v]) => (
        <div key={k} className="flex gap-2 text-[11px]">
          <span className="w-40 shrink-0 text-slate-500">{k}</span>
          <span className="break-all font-mono text-slate-300">{v}</span>
        </div>
      ))}
    </div>
  );
}

function RowActions({
  row,
  canOperate,
  busy,
  run,
}: {
  row: QueueRow;
  canOperate: boolean;
  busy: string | null;
  run: (key: string, path: string, body?: unknown) => Promise<boolean>;
}) {
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const [reconciling, setReconciling] = useState(false);
  const [outcome, setOutcome] = useState<"SENT" | "FAILED">("SENT");
  const [txHash, setTxHash] = useState("");
  const [evidence, setEvidence] = useState("");

  if (!canOperate) {
    return <span className="text-[10px] text-slate-600">view only</span>;
  }

  // Broadcast happened, outcome unknown. No Approve. No Send. Ever.
  if (row.status === "NEEDS_RECONCILIATION") {
    return (
      <div className="min-w-64">
        <div className="rounded border border-red-600 bg-red-950/70 px-2 py-1.5 text-[11px] leading-relaxed text-red-100">
          A transaction was broadcast for this payout and its outcome is
          unknown. There is no retry: sending again would pay twice. Look the
          treasury address up on MonadScan, find or rule out a transfer of{" "}
          <span className="font-mono">{row.amountMon}</span> to{" "}
          <span className="font-mono">{row.player.walletAddress}</span> around{" "}
          <span className="font-mono">
            {row.spawn.collectedAt ?? row.createdAt}
          </span>
          , then record what you found.
        </div>
        {!reconciling ? (
          <button
            type="button"
            onClick={() => setReconciling(true)}
            className="mt-1 rounded border border-red-500 px-2 py-1 text-[11px] text-red-200 hover:bg-red-900"
          >
            Reconcile against the chain
          </button>
        ) : (
          <div className="mt-1 flex flex-col gap-1">
            <select
              value={outcome}
              onChange={(e) =>
                setOutcome(e.target.value === "FAILED" ? "FAILED" : "SENT")
              }
              className="rounded border border-slate-700 bg-slate-900 px-1 py-1 text-[11px]"
            >
              <option value="SENT">
                SENT — I found the confirmed transfer
              </option>
              <option value="FAILED">
                FAILED — no transfer landed; make it sendable again
              </option>
            </select>
            {outcome === "SENT" && (
              <input
                value={txHash}
                onChange={(e) => setTxHash(e.target.value)}
                placeholder="0x… confirmed transaction hash"
                className="rounded border border-slate-700 bg-slate-900 px-1 py-1 font-mono text-[11px]"
              />
            )}
            <textarea
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              placeholder="What you checked and what you found (required, kept in the audit trail)"
              rows={2}
              className="rounded border border-slate-700 bg-slate-900 px-1 py-1 text-[11px]"
            />
            <div className="flex gap-1">
              <button
                type="button"
                disabled={busy === row.id || evidence.trim().length < 10}
                onClick={async () => {
                  const ok = await run(
                    row.id,
                    `/api/admin/payouts/${row.id}/reconcile`,
                    { outcome, txHash: txHash.trim() || undefined, evidence },
                  );
                  if (ok) setReconciling(false);
                }}
                className="rounded bg-red-700 px-2 py-1 text-[11px] font-semibold text-white hover:bg-red-600 disabled:opacity-40"
              >
                Record
              </button>
              <button
                type="button"
                onClick={() => setReconciling(false)}
                className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-400"
              >
                cancel
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (row.status === "SENDING") {
    return (
      <span className="text-[11px] text-amber-300">
        broadcast in flight — leave it alone until it settles
      </span>
    );
  }

  if (row.status === "SENT" || row.status === "VOIDED") {
    return <span className="text-[10px] text-slate-600">terminal</span>;
  }

  if (row.status === "FAILED" && row.txHash) {
    return (
      <span className="text-[11px] text-red-300">
        FAILED but carries a txHash — this should not happen. Do not approve;
        escalate.
      </span>
    );
  }

  const canApprove =
    row.status === "PENDING" || (row.status === "FAILED" && !row.txHash);
  const canVoid = row.status === "PENDING" || row.status === "APPROVED";
  const canSend = row.status === "APPROVED";

  return (
    <div className="flex min-w-48 flex-col gap-1">
      <div className="flex flex-wrap gap-1">
        {canApprove && (
          <button
            type="button"
            disabled={busy === row.id}
            onClick={() => run(row.id, `/api/admin/payouts/${row.id}/approve`)}
            className="rounded bg-emerald-700 px-2 py-1 text-[11px] font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
          >
            {row.status === "FAILED" ? "Re-approve" : "Approve"}
          </button>
        )}
        {canSend && (
          <button
            type="button"
            disabled={busy === row.id}
            onClick={() => run(row.id, `/api/admin/payouts/${row.id}/send`)}
            className="rounded bg-sky-700 px-2 py-1 text-[11px] font-semibold text-white hover:bg-sky-600 disabled:opacity-40"
            title="Broadcasts native MON to the player. Irreversible."
          >
            Send now
          </button>
        )}
        {canVoid && !voiding && (
          <button
            type="button"
            onClick={() => setVoiding(true)}
            className="rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
          >
            Void
          </button>
        )}
      </div>

      {voiding && (
        <div className="flex flex-col gap-1">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this refused? (required)"
            className="rounded border border-slate-700 bg-slate-900 px-1 py-1 text-[11px]"
          />
          <div className="flex gap-1">
            <button
              type="button"
              disabled={reason.trim().length < 4 || busy === row.id}
              onClick={async () => {
                const ok = await run(
                  row.id,
                  `/api/admin/payouts/${row.id}/void`,
                  { reason },
                );
                if (ok) setVoiding(false);
              }}
              className="rounded bg-slate-700 px-2 py-1 text-[11px] text-white hover:bg-slate-600 disabled:opacity-40"
            >
              Confirm void
            </button>
            <button
              type="button"
              onClick={() => setVoiding(false)}
              className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-400"
            >
              cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
