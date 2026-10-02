// Fill in MON received on Kuru rows recorded before it was decoded.
//
// Every KuruSwap row written before 2 October 2026 has nativeInWei NULL,
// because nothing read it: native MON moves no Transfer event, so a buy stored
// an empty tokensIn map and the amount the hunter actually got was never
// anywhere. The column is nullable and the migration set no default precisely
// so those rows could say "unknown" instead of claiming nought, and this is
// what converts them to a real figure.
//
// It re-reads each receipt off the chain and runs the SAME decoder the live
// route uses — not a copy of it. A backfill with its own private arithmetic
// produces history that disagrees with everything recorded after it, and the
// disagreement surfaces months later in a total nobody can reconcile.
//
// AN ADMIN ROUTE RATHER THAN A SCRIPT, for the reason the editions sweeper is
// one: it writes to production, so it gets a human, an audit row, and a dry run
// by default. A GET only ever reports. It spends no gas and moves no assets —
// the worst a mistake here does is write a wrong number, which is also the
// reason it reports every value before it writes any.
import { AdminRole } from "@prisma/client";
import { isHash } from "viem";
import { requireAdminApi } from "@/lib/admin/auth";
import { logAdminAction } from "@/lib/admin/audit";
import { adminErrorResponse, jsonOk, readJson } from "@/lib/admin/http";
import { prisma } from "@/lib/db/prisma";
import { publicClient } from "@/lib/cota/swap";
import {
  nativeReceived,
  nativeReceivedFromTrace,
  type MinimalReceipt,
  type TraceFrame,
} from "@/lib/cota/kuru-history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One page of rows. Small enough that the report is readable before writing. */
const MAX_LIMIT = 50;

interface Row {
  hash: string;
  wallet: string;
  side: string;
  ok: boolean;
  /** Decoded wei, or null where the chain could not settle it. */
  nativeInWei: string | null;
  source: "event" | "trace" | "revert" | "unknown";
}

/**
 * Decode one recorded trade's MON receipt from the chain.
 *
 * Mirrors the live route's order exactly: the event first, the trace only when
 * the event said nothing, null when neither did. Keeping the order the same is
 * the point — a backfill that consulted the trace first could write a figure
 * the live path would never produce for the same transaction.
 */
async function decode(hash: string, wallet: string, ok: boolean): Promise<Row> {
  const base = { hash, wallet, ok, side: "" };
  // A revert delivered nothing, and that is known rather than unknown. No RPC
  // call needed, and no trace to read: a reverted transaction emits no logs.
  if (!ok) return { ...base, nativeInWei: "0", source: "revert" };

  let receipt;
  try {
    receipt = (await publicClient().getTransactionReceipt({
      hash: hash as `0x${string}`,
    })) as unknown as MinimalReceipt;
  } catch {
    // Pruned, or an RPC that has lost it. Leaving the row NULL is correct; it
    // is still unestablished, which is exactly what NULL says.
    return { ...base, nativeInWei: null, source: "unknown" };
  }

  const fromEvent = nativeReceived(receipt.logs, wallet);
  if (fromEvent !== null) {
    return { ...base, nativeInWei: fromEvent.toString(), source: "event" };
  }

  try {
    const frame = (await publicClient().request({
      method: "debug_traceTransaction",
      params: [hash, { tracer: "callTracer" }],
    } as never)) as TraceFrame | null;
    if (frame && typeof frame === "object") {
      return {
        ...base,
        nativeInWei: nativeReceivedFromTrace(frame, wallet).toString(),
        source: "trace",
      };
    }
  } catch {
    // Falls through to unknown. An RPC without the debug namespace is a
    // perfectly ordinary reason to be unable to tell.
  }
  return { ...base, nativeInWei: null, source: "unknown" };
}

async function report(
  limit: number,
): Promise<{ rows: Row[]; remaining: number }> {
  const pending = await prisma.kuruSwap.findMany({
    where: { nativeInWei: null },
    orderBy: { at: "asc" },
    take: limit,
    select: { hash: true, wallet: true, side: true, ok: true },
  });
  const rows: Row[] = [];
  for (const p of pending) {
    // Serial, not Promise.all. The rows are few and the public RPC rate-limits;
    // a burst that gets throttled reports "unknown" for rows that are fine.
    if (!isHash(p.hash)) {
      rows.push({ ...p, nativeInWei: null, source: "unknown" });
      continue;
    }
    const d = await decode(p.hash, p.wallet, p.ok);
    rows.push({ ...d, side: p.side });
  }
  const remaining = await prisma.kuruSwap.count({
    where: { nativeInWei: null },
  });
  return { rows, remaining };
}

/** Report only. Never writes, whatever it is asked. */
export async function GET() {
  try {
    await requireAdminApi(AdminRole.OPERATOR);
    const r = await report(MAX_LIMIT);
    return jsonOk({ dryRun: true, ...r });
  } catch (e) {
    return adminErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const admin = await requireAdminApi(AdminRole.OPERATOR);
    const body = await readJson(req);

    // Opt in by exact value. A truthy check would let the string "false" write.
    const execute = body.execute === true;
    const limit =
      typeof body.limit === "number" && body.limit > 0
        ? Math.min(Math.floor(body.limit), MAX_LIMIT)
        : MAX_LIMIT;

    const r = await report(limit);

    let written = 0;
    if (execute) {
      for (const row of r.rows) {
        // A row we could not settle is SKIPPED, not written. Writing "0" here
        // is the single thing this endpoint must never do: it would turn an
        // unknown into a confident nought that no later pass would revisit,
        // because the NULL that marks it as needing one would be gone.
        if (row.nativeInWei === null) continue;
        await prisma.kuruSwap.update({
          where: { hash: row.hash },
          data: { nativeInWei: row.nativeInWei },
        });
        written += 1;
      }
    }

    await logAdminAction({
      adminId: admin.id,
      action: execute ? "cota.kuruBackfill.execute" : "cota.kuruBackfill.dry",
      targetType: "KuruSwap",
      targetId: r.rows.map((x) => x.hash).join(",") || "-",
      detail: JSON.stringify({
        examined: r.rows.length,
        written,
        skipped: r.rows.filter((x) => x.nativeInWei === null).length,
        bySource: r.rows.reduce<Record<string, number>>((a, x) => {
          a[x.source] = (a[x.source] ?? 0) + 1;
          return a;
        }, {}),
      }),
    });

    return jsonOk({ dryRun: !execute, written, ...r });
  } catch (e) {
    return adminErrorResponse(e);
  }
}
