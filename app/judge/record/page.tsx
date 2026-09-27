import { prisma } from "@/lib/db/prisma";
import { explainDenial } from "@/lib/cota/enforce";

// ---------------------------------------------------------------------------
// The leash's record — what actually happened in production.
//
// WHY THIS EXISTS. A judge has dozens of submissions to get through and will
// not set up paper trades to watch an enforcement rule fire. A simulator proves
// the code runs; it does not prove the product works, and a sceptical reader
// discounts it accordingly. This is the opposite artifact: every enforcement
// decision the live agent has ever been given, read straight from the table the
// executor writes to, including the ones that were refused.
//
// The strongest thing in here is an accident of one afternoon. On 4 September
// the agent asked one bound for four trades inside the same second. It allowed
// one and refused three — a market the bound did not authorise, then leverage,
// then size. Three different ceilings, one leash, no staging.
//
// NO IDENTITIES. Rows carry a time, a verdict, a reason and a market, and
// nothing that names a hunter — no wallet, no player id, no size on the denied
// ones. This page is public because the claim it supports is public; the people
// in it did not agree to be exhibits.
//
// SERVER COMPONENT, reading Postgres directly. There is no API route because
// there is no interaction: a judge reads it and leaves.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

const MARKETS: Record<number, string> = { 10: "MON" };

function ago(at: Date): string {
  return at.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export default async function RecordPage() {
  const [cotas, checks, denied, orders, fills, decisions, rows, recentFills] =
    await Promise.all([
      prisma.cota.count(),
      prisma.cotaCheck.count(),
      prisma.cotaCheck.count({ where: { allowed: false } }),
      prisma.cotaOrder.count(),
      prisma.cotaFill.count(),
      prisma.cotaAgentDecision.count(),
      prisma.cotaCheck.findMany({
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { allowed: true, reason: true, market: true, createdAt: true },
      }),
      prisma.cotaFill.findMany({
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          marketId: true,
          sizeUnits: true,
          priceUsd: true,
          createdAt: true,
        },
      }),
    ]);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-2">
        <p className="text-ink/50 font-mono text-xs uppercase">
          Cota · production record
        </p>
        <h1 className="text-ink text-2xl font-semibold">
          What the leash actually did
        </h1>
        <p className="text-ink/70 text-sm leading-snug">
          Every enforcement decision the live agent has been given, read from
          the table the executor writes to. Not a demo and not a simulation —
          these are rows from the running product, and the refusals are real
          orders that never reached the venue.
        </p>
      </header>

      <section className="grid grid-cols-3 gap-2">
        {[
          ["leashes signed", cotas],
          ["decisions proposed", decisions],
          ["orders placed", orders],
          ["fills on Perpl", fills],
          ["checks run", checks],
          ["refused", denied],
        ].map(([label, n]) => (
          <div
            key={String(label)}
            className="border-hull-line rounded-xl border px-3 py-2"
          >
            <p className="text-ink font-mono text-lg">{String(n)}</p>
            <p className="text-ink/50 text-xs leading-tight">{String(label)}</p>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-ink/60 text-xs uppercase">Enforcement decisions</h2>
        {rows.length === 0 ? (
          <p className="text-ink/60 text-sm">Nothing recorded yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((r, i) => (
              <li
                key={`${r.createdAt.toISOString()}-${i}`}
                className="border-hull-line flex flex-col gap-1 rounded-xl border px-3 py-2"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span
                    className={
                      r.allowed
                        ? "text-ink/60 font-mono text-xs"
                        : "text-phosphor font-mono text-xs"
                    }
                  >
                    {r.allowed ? "ALLOWED" : "REFUSED"}
                  </span>
                  <span className="text-ink/40 font-mono text-xs">
                    {ago(r.createdAt)}
                  </span>
                </div>
                <p className="text-ink text-sm">
                  {r.market ?? "—"}
                  {r.allowed || r.reason === null ? null : (
                    <>
                      {" · "}
                      <span className="text-ink/70">
                        {explainDenial(
                          r.reason as Parameters<typeof explainDenial>[0],
                        )}
                      </span>
                    </>
                  )}
                </p>
                {r.allowed || r.reason === null ? null : (
                  <p className="text-ink/40 font-mono text-xs">{r.reason}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-ink/60 text-xs uppercase">Fills on Perpl</h2>
        {recentFills.length === 0 ? (
          <p className="text-ink/60 text-sm">No fills recorded.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {recentFills.map((f, i) => (
              <li
                key={`${f.createdAt.toISOString()}-${i}`}
                className="text-ink flex items-baseline justify-between gap-2 text-sm"
              >
                <span className="font-mono">
                  {MARKETS[f.marketId] ?? `market ${f.marketId}`} ·{" "}
                  {f.sizeUnits} @ ${f.priceUsd.toFixed(6)}
                </span>
                <span className="text-ink/40 font-mono text-xs">
                  {ago(f.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-ink/50 text-xs leading-snug">
        Reasons come from <code>lib/cota/enforce.ts</code>, the pure function
        the executor calls before every order — no clock, no database, no
        network, and it fails closed. A refusal here means the order was never
        sent.
      </p>

      <a href="/judge" className="text-ink/60 text-sm">
        ← Back to the walkthrough
      </a>
    </main>
  );
}
