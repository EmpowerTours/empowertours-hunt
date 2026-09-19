import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { loadPerpKey } from "@/lib/cota/keystore";
import { executableMarket, planClose, planOpen } from "@/lib/cota/order";
import { placeOrder } from "@/lib/cota/venue/client";
import { readMark, readBook } from "@/lib/cota/venue/market-data";
import { readAccountPositions } from "@/lib/cota/venue/account-read";
import {
  entryUsdWithResidue,
  signedSizeFromFrame,
} from "@/lib/cota/venue/aggregate";
import { exitPriceFor } from "@/lib/cota/venue/market-data";
import { venueConfirmedFill, venueRefusedOrder } from "@/lib/cota/venue/frames";
import type { MarkedMarket } from "@/lib/cota/venue/account-state";
import { readDayState } from "@/lib/cota/day-state";
import { boundFromRow } from "@/lib/cota/bound";
import { observeOnly, verifyStoredGrant } from "@/lib/cota/autonomy";
import { decide } from "@/lib/cota/agent/decide";
import { postOnlyPrice } from "@/lib/cota/post-only-price";
import { TIF_POST_ONLY } from "@/lib/cota/order";
import { releaseAgentLease, takeAgentLease } from "@/lib/cota/agent/lease";
import { proposeOrder, ProposerError } from "@/lib/cota/propose";
import {
  recordFill,
  recordPlacedOrder,
  fillToLedgerFill,
  directionOfOrderType,
  newAgentOrderId,
} from "@/lib/cota/ledger";

// ---------------------------------------------------------------------------
// POST /api/cota/agent/run — the agent acts, with nobody watching.
//
// Triggered by a scheduler holding COTA_AGENT_TOKEN. Everything it is allowed to
// do was authorised earlier by two separate signatures from the hunter: the Cota
// (how much) and the autonomy grant (whether, unattended). This route adds no
// authority of its own — it can only spend what those two already permit.
//
// ## The token cannot widen anything
//
// Worth being explicit, because a shared secret that can cause trades sounds
// alarming and the bounding is what makes it not. A leaked token lets somebody
// make the agent RUN. It does not let them choose a side, a size, a market or a
// moment: the leash decides all four, the grant decides whether any of it may
// happen unattended, and the exit policy refuses to realise a loss. The worst a
// leaked token achieves is the agent doing its ordinary job at a time the
// attacker picked, which costs fees inside a ceiling the hunter signed.
//
// It also cannot touch a hunter who has not opted in. Candidates come from
// leashes carrying a grant, and each grant's signature is re-verified here
// against the hunter's own wallet before anything is read, let alone sent.
//
// ## Decisions are made by decide(), which does no I/O
//
// This file reads, calls decide(), and sends. The judgement lives in
// lib/cota/agent/decide.ts precisely so it can be tested without a venue, and so
// that what the agent will do is readable without tracing a socket.
// ---------------------------------------------------------------------------

/** Hunters handled per invocation. A scheduler calls again; a loop does not. */
const MAX_PER_RUN = 10;

const Input = z.object({
  /** Limit a run to one hunter — for a manual check or a targeted retry. */
  playerId: z.string().min(1).max(64).optional(),
  /** Decide and report, send nothing. The way to watch it think. */
  dryRun: z.boolean().optional(),
});

function unauthorised() {
  return NextResponse.json({ error: "unauthorised" }, { status: 401 });
}

export async function POST(req: Request) {
  const expected = process.env.COTA_AGENT_TOKEN;
  // Unset means the seam is closed, not open — the same rule /check follows.
  if (expected === undefined || expected.length < 16) return unauthorised();
  if (req.headers.get("authorization") !== `Bearer ${expected}`) {
    return unauthorised();
  }

  const parsed = Input.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const { playerId, dryRun } = parsed.data;

  const candidates = await prisma.cota.findMany({
    where: {
      ...(playerId ? { playerId } : {}),
      autonomy: { not: null },
      revokedAt: null,
      anchorTxHash: { not: null },
      notAfter: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
    take: MAX_PER_RUN,
    include: { player: { select: { id: true, walletAddress: true } } },
  });

  const results: unknown[] = [];

  for (const cota of candidates) {
    // Every decision is recorded, the boring ones included. Holding is what the
    // agent does nearly all the time, and a log that shows only trades makes a
    // working agent indistinguishable from a dead one.
    const log = (o: Record<string, unknown>) => {
      results.push({ playerId: cota.playerId, digest: cota.digest, ...o });
      const { act, why, ...detail } = o as { act?: string; why?: string };
      void prisma.cotaAgentDecision
        .create({
          data: {
            playerId: cota.playerId,
            cotaDigest: cota.digest,
            act: String(act ?? "nothing"),
            why: String(why ?? ""),
            dryRun: dryRun === true,
            detail: Object.keys(detail).length ? (detail as object) : undefined,
          },
        })
        // Recording is observability, not control. A failed write must never
        // stop the agent doing its job, and it must never be retried into a
        // second order.
        .catch((e) => console.error("[cota/agent] decision log failed", e));
    };

    // The grant, re-verified. A row someone wrote without the hunter's key
    // fails here and the hunter is skipped entirely.
    const grant = await verifyStoredGrant({
      stored: cota.autonomy,
      cotaDigest: cota.digest,
      signature: cota.autonomySignature,
      nonce: cota.autonomyNonce,
      notAfter: cota.autonomyNotAfter,
      walletAddress: cota.player.walletAddress,
    });
    if (grant.mode === "off") {
      log({ act: "nothing", why: `grant_${grant.reason ?? "invalid"}` });
      continue;
    }

    // Single-flight. Two schedulers — a minute-by-minute poll and a hosted cron
    // that fires whenever it likes — WILL overlap, and two runs that both read
    // the same unsettled position both send a full close, which flips the
    // position instead of closing it. Whoever loses the race simply skips.
    if (!dryRun && !(await takeAgentLease(cota.id))) {
      log({ act: "nothing", why: "another_run_holds_the_lease" });
      continue;
    }

    const symbol = cota.markets.find((m) => executableMarket(m));
    const market = symbol ? executableMarket(symbol) : undefined;
    if (!market) {
      if (!dryRun) await releaseAgentLease(cota.id);
      log({ act: "nothing", why: "no_reachable_market" });
      continue;
    }

    const cred = await loadPerpKey(cota.playerId);
    if (!cred) {
      if (!dryRun) await releaseAgentLease(cota.id);
      log({ act: "nothing", why: "no_trading_key" });
      continue;
    }

    try {
      const markUsd = await readMark(market.id, market.priceDecimals);
      const book = await readBook(market.id, market.priceDecimals);
      const marks = new Map<number, MarkedMarket>([
        [market.id, { market, markUsd }],
      ]);

      const read = await readAccountPositions({
        apiKey: cred.apiKey,
        secretHex: cred.secretHex,
      });
      const frame = read.positions.find((p) => p.marketId === market.id);
      const signedSize = frame ? signedSizeFromFrame(frame, marks) : 0;
      const entryUsd = frame
        ? entryUsdWithResidue(frame, market.priceDecimals)
        : null;
      const exitPriceUsd = book ? exitPriceFor(signedSize, book) : null;

      // The leash's own view, which the open path needs and the close path does
      // not. Read once either way so a dry run reports the same state the live
      // run would act on.
      const day = await readDayState({
        playerId: cota.playerId,
        account: cred.account,
        apiKey: cred.apiKey,
        secretHex: cred.secretHex,
        marks,
        nowMs: Date.now(),
      });

      const plan = decide({
        mode: grant.mode,
        position:
          frame && entryUsd !== null
            ? {
                signedSize,
                entryUsd,
                exitPriceUsd: exitPriceUsd ?? 0,
                feesPaidUsd: (frame.feeScaled ?? 0) / 1_000_000,
              }
            : null,
        exitPriceUsd,
        // A null day-state means loss could not be vouched for, and the leash
        // refuses opens on it. Never let the agent be the caller that trades
        // through an unverifiable loss read.
        mayOpenNow: day.dayState !== null && read.account !== null,
      });

      if (plan.act === "nothing") {
        log({ act: "nothing", why: plan.why });
        continue;
      }
      // Two different reasons not to send, kept apart in the log because they
      // are different facts. dryRun is ours — an operator switch covering the
      // whole run. observe is the HUNTER'S, on their own leash, and is the only
      // one of the two they control.
      if (observeOnly(grant.mode)) {
        log({
          act: plan.act,
          why: plan.why,
          observed: true,
          ...(plan.act === "close"
            ? { netUsd: plan.netUsd, netBps: plan.netBps }
            : {}),
        });
        continue;
      }
      if (dryRun) {
        log({
          act: plan.act,
          why: plan.why,
          dryRun: true,
          ...(plan.act === "close"
            ? { netUsd: plan.netUsd, netBps: plan.netBps }
            : {}),
        });
        continue;
      }
      if (read.account && !read.account.forwardingAllowed) {
        log({ act: "nothing", why: "forwarding_disabled" });
        continue;
      }

      const agentOrderId = newAgentOrderId();

      if (plan.act === "close") {
        const cp = planClose({
          market,
          openSignedSize: signedSize,
          markPriceUsd: exitPriceUsd ?? markUsd,
        });
        if (!cp.decision.ok) {
          log({ act: "nothing", why: `close_${cp.decision.reason}` });
          continue;
        }
        const result = await placeOrder({
          apiKey: cred.apiKey,
          secretHex: cred.secretHex,
          market,
          orderType: cp.orderType,
          sizeUnits: cp.sizeUnits,
          leverageX: frame ? frame.leverageX100 / 100 : 1,
          feeBps: 0,
        });
        await recordOutcome(cota.playerId, cred.account, {
          result,
          market,
          orderType: cp.orderType,
          sizeUnits: cp.sizeUnits,
          agentOrderId,
          markUsd,
        });
        log({
          act: "close",
          netUsd: plan.netUsd,
          netBps: plan.netBps,
          filled: result.filled,
          accepted: result.accepted,
          venue: result.update?.reasonName ?? null,
        });
        continue;
      }

      // OPEN — full grants only, and only from flat. Kimi chooses side and
      // size; the leash decides whether what it chose may happen.
      let proposal;
      try {
        proposal = await proposeOrder({
          bound: boundFromRow(cota),
          state: day.dayState!,
          markets: [{ market: market.symbol, priceUsd: markUsd }],
          nowSeconds: BigInt(Math.floor(Date.now() / 1000)),
        });
      } catch (e) {
        // A proposer that is down is not a reason to trade, and not an error
        // worth failing the whole run over.
        log({
          act: "nothing",
          why:
            e instanceof ProposerError
              ? "proposer_unavailable"
              : "propose_failed",
        });
        continue;
      }
      if (proposal.proposal.action !== "open" || !proposal.decision.ok) {
        log({
          act: "nothing",
          why: proposal.decision.ok ? "proposer_holds" : "leash_refused",
        });
        continue;
      }

      const op = planOpen({
        bound: boundFromRow(cota),
        state: day.dayState!,
        market,
        side: proposal.proposal.side === "short" ? "short" : "long",
        targetNotionalUsd: proposal.proposal.notionalUsd ?? 0,
        markPriceUsd: markUsd,
        leverageX: proposal.proposal.leverage ?? 1,
        nowSeconds: BigInt(Math.floor(Date.now() / 1000)),
      });
      if (!op.decision.ok || op.sizeUnits <= 0) {
        log({
          act: "nothing",
          why: op.decision.ok ? "size_zero" : `leash_${op.decision.reason}`,
        });
        continue;
      }

      // Rest, do not cross. Perpl charges 6.9 bps to take and 0.9 to make, and
      // the take-profit threshold exists mostly to clear that friction — so an
      // entry that makes rather than takes is not a marginal saving, it is most
      // of the round trip.
      //
      // Only the OPEN rests. Not filling while flat costs nothing: the agent was
      // already flat, stays flat, and the next tick asks again. The close still
      // crosses, because not filling THERE means sitting in a position it has
      // decided to leave while the price that made the exit profitable walks
      // away. Patient in, decisive out.
      const quote = book
        ? postOnlyPrice(
            market,
            proposal.proposal.side === "short" ? "short" : "long",
            book,
          )
        : null;
      if (!quote) {
        log({ act: "nothing", why: "no_touch_to_rest_on" });
        continue;
      }

      const result = await placeOrder({
        apiKey: cred.apiKey,
        secretHex: cred.secretHex,
        market,
        orderType: op.orderType,
        sizeUnits: op.sizeUnits,
        leverageX: proposal.proposal.leverage ?? 1,
        feeBps: 2,
        priceUsd: quote.priceUsd,
        flags: TIF_POST_ONLY,
      });
      await recordOutcome(cota.playerId, cred.account, {
        result,
        market,
        orderType: op.orderType,
        sizeUnits: op.sizeUnits,
        agentOrderId,
        markUsd,
      });
      log({
        act: "open",
        postOnly: true,
        priceUsd: quote.priceUsd,
        insideTicks: quote.insideTicks,
        sizeUnits: op.sizeUnits,
        notionalUsd: op.notionalUsd,
        filled: result.filled,
        accepted: result.accepted,
        venue: result.update?.reasonName ?? null,
      });
    } catch (e) {
      // One hunter's venue failure must not stop the others being served.
      console.error("[cota/agent] hunter failed", cota.playerId, e);
      log({ act: "nothing", why: "error" });
    } finally {
      // Always, including after an order was sent. The expiry is a backstop for
      // a process that dies, not the normal path — holding a leash for 90s after
      // a clean run would make a minute-by-minute poll skip every other tick.
      if (!dryRun) await releaseAgentLease(cota.id);
    }
  }

  return NextResponse.json({ ran: candidates.length, results });
}

/** Same recording contract the hunter-driven routes use. */
async function recordOutcome(
  playerId: string,
  account: string,
  a: {
    result: Awaited<ReturnType<typeof placeOrder>>;
    market: Parameters<typeof fillToLedgerFill>[1];
    orderType: number;
    sizeUnits: number;
    agentOrderId: number;
    /** Perpl's mark read just before this order went out. */
    markUsd: number;
  },
) {
  const { result } = a;
  try {
    if (result.filled && result.fill) {
      await recordFill(
        playerId,
        account,
        fillToLedgerFill(
          result.fill,
          a.market,
          a.orderType,
          Date.now(),
          a.agentOrderId,
          a.markUsd,
        ),
      );
    } else if (result.accepted && !venueRefusedOrder(result.update)) {
      await recordPlacedOrder(playerId, account, {
        marketId: a.market.id,
        direction: directionOfOrderType(a.orderType),
        sizeUnits: a.sizeUnits,
        orderId: a.agentOrderId,
        venueConfirmedFill: venueConfirmedFill(result.update),
        venueStatus: result.update?.statusName ?? null,
      });
    }
  } catch (e) {
    console.error("[cota/agent] record failed", e);
  }
}
