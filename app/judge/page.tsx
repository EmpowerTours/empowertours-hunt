"use client";

import { useCallback, useEffect, useState } from "react";
import { Disclosure, Note, Panel } from "@/components/ui/primitives";

// ---------------------------------------------------------------------------
// The judge's walkthrough — a guide, not a checklist.
//
// The first version of this page was twelve rows with twelve checkboxes, and it
// read like homework: it asked a judge to keep their own score through somebody
// else's product and to decide for themselves where to start. That is a menu,
// not a walkthrough.
//
// This shows the current step and advances on its own. Signing in completes a
// step. A signed leash completes the next. A deposit landing completes the one
// after, with nothing to click and nothing to claim, because
// /api/judge/progress reads the real state: the session for the wallet, our
// table for the leash, Monad for the balances. A judge cannot mark their own
// homework and neither can we.
//
// Steps that cannot be observed — reading a file on GitHub, installing an APK —
// carry a manual "I've done this" and say which they are. Better that the
// honest half is automatic than that the whole thing pretends to know.
//
// ORDERING IS THE ARGUMENT. Seven steps run on an empty wallet and carry the
// whole case, the refusal among them. Only then does it ask for money, and the
// step that asks IS the Aurora bounty, so funding is a demonstration rather
// than a toll.
// ---------------------------------------------------------------------------

interface Progress {
  signedIn: boolean;
  wallet?: string;
  hasLeash?: boolean;
  anchored?: boolean;
  anchorTxHash?: string | null;
  hasNote?: boolean;
  hasDepositAddress?: boolean;
  depositAddress?: string | null;
  funded?: boolean | null;
  hasAusd?: boolean | null;
}

interface Step {
  id: string;
  title: string;
  bounty: string;
  /** Why this is worth the judge's next sixty seconds. */
  why: string;
  action: string;
  href: string;
  /** Reads live state. Undefined means it cannot be observed from here. */
  isDone?: (p: Progress) => boolean;
  /** True while a previous step's money has not arrived. */
  gated?: (p: Progress) => boolean;
}

const STEPS: Step[] = [
  {
    id: "signin",
    title: "Sign in with your face",
    bounty: "Best Mera-Powered UX on Monad · Monad Foundation",
    why: "Mera is the entire account layer. We deleted the embedded-wallet SDK rather than leave a second path that could hand someone the wrong wallet.",
    action:
      "One passkey prompt and you hold a Monad wallet — no email, no seed phrase, no extension. Come back here when you are in.",
    href: "/cota",
    isDone: (p) => p.signedIn,
  },
  {
    id: "leash",
    title: "Sign a bound the software cannot exceed",
    bounty: "Best use of Perpl's API · Perpl",
    why: "One market, a maximum leverage, a maximum size, a daily loss ceiling. Plain language and EIP-712 at once. That signature is the agent's entire authority.",
    action:
      "Set your numbers on the Cota form and sign. It costs nothing — the signature never touches the chain.",
    href: "/cota",
    isDone: (p) => p.hasLeash === true,
  },
  {
    id: "record",
    title: "Read what the leash actually refused",
    bounty:
      "The point of the product — read this one even if you skip the rest",
    why: "On 4 September the live agent asked one bound for four trades inside the same second. It allowed one and refused three: a market the Cota did not name, then leverage, then size. Three ceilings, one leash, no staging.",
    action:
      "Open the production record. Those rows were written by the executor — a refusal there means the order never reached the venue, and four real fills on Perpl sit underneath.",
    href: "/judge/record",
  },
  {
    id: "note",
    title: "Write a note only your face can open",
    bounty: "Mera: One Passkey, Many Keys · Monad Foundation",
    why: "A second PRF salt derives an AES-GCM key that is not a wallet and signs nothing. Your note is stored as ciphertext this server cannot read.",
    action:
      "Write a note against your leash. Clear this site's data, sign in again, and it decrypts — the key came from your passkey and was never stored anywhere.",
    href: "/cota/trade",
    isDone: (p) => p.hasNote === true,
  },
  {
    id: "kimi",
    title: "See what proposes the trades",
    bounty: "Best Builds Powered by KIMI · Kimi",
    why: "The agent's proposals come from KIMI. Every one is checked against your signed bound before it can reach the venue — the model proposes, the leash disposes.",
    action: "Read lib/cota/propose.ts.",
    href: "https://github.com/EmpowerTours/empowertours-hunt/blob/master/lib/cota/propose.ts",
  },
  {
    id: "cre",
    title: "See what schedules the agent",
    bounty: "Best workflow with CRE · Chainlink",
    why: "A Chainlink Runtime Environment workflow drives the agent — workflow.yaml, staging and production config, and a recorded CRE-CLI simulation run.",
    action: "Read cre/agent-scheduler/, including SIMULATION.md.",
    href: "https://github.com/EmpowerTours/empowertours-hunt/tree/master/cre/agent-scheduler",
  },
  {
    id: "mobile",
    title: "Put it on a phone",
    bounty: "Best Mobile Trading App on Monad · Agora",
    why: "The same passkey yields the same address on the web, in the Android APK and on iOS through TestFlight. A different origin would have silently handed a player a second, empty wallet.",
    action:
      "Open this on a phone and add it to your home screen, or install the APK.",
    href: "/download",
  },
  {
    id: "fund",
    title: "Fund yourself from any chain",
    bounty: "Bring Any-Chain Liquidity to Monad · Aurora Intents",
    why: "One permanent address accepts twelve EVM chains and dozens of assets, and delivers MON — so a newcomer can pay their own gas the moment they arrive. A real 2 USDC transfer from Base settled in fourteen seconds.",
    action:
      "Take your address and send a few dollars. About $2 covers gas and the swap; Perpl needs 10 AUSD more to open an account. Watch it land in the arrivals list — this page notices on its own.",
    href: "/cota/onramp",
    isDone: (p) => p.funded === true,
  },
  {
    id: "anchor",
    title: "Put your bound on chain",
    bounty: "Verifiable by anyone, not just by us",
    why: "Anchoring writes your leash digest to AuditAnchorV2 from your own wallet. The bound stops resting on our database and starts resting on a chain event.",
    action:
      "Anchor the leash you signed, then open the transaction. Your address, your digest.",
    href: "/cota",
    isDone: (p) => p.anchored === true,
    gated: (p) => p.funded !== true,
  },
  {
    id: "swap",
    title: "Turn it into collateral",
    bounty: "Build the Next Consumer Trading App on Kuru · Kuru",
    why: "MON to AUSD routes through Kuru's on-chain order book and a Uniswap v4 pool, with the book crossing verified from the transaction's own logs.",
    action:
      "Swap the MON that arrived into AUSD, which is what Perpl settles in.",
    href: "/cota/swap",
    isDone: (p) => p.hasAusd === true,
    gated: (p) => p.funded !== true,
  },
  {
    id: "trade",
    title: "Trade under your own ceiling",
    bounty: "Best Analytics / Risk Tool · Perpl",
    why: "With a real position open, the risk screen shows live exposure, leverage, and how far you are from the ceiling you set yourself.",
    action:
      "Deposit the AUSD into Perpl, place a trade under your leash, then watch the distance to your own limit — and try to exceed it.",
    href: "/cota/deposit",
    gated: (p) => p.hasAusd !== true,
  },
];

const STORAGE = "judge.walk.v2";

export default function JudgePage() {
  const [progress, setProgress] = useState<Progress>({ signedIn: false });
  const [manual, setManual] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState<string | null>(null);

  // Poll the real state. This is what makes it a guide rather than a list: a
  // judge who wanders off to sign in comes back to a step that has moved.
  useEffect(() => {
    let live = true;
    const pull = async () => {
      try {
        const res = await fetch("/api/judge/progress", { cache: "no-store" });
        if (!live || !res.ok) return;
        setProgress((await res.json()) as Progress);
      } catch {
        // Keep the last known state. A failed poll must never un-tick a step.
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), 6000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let live = true;
    try {
      const raw = localStorage.getItem(STORAGE);
      if (raw !== null) {
        const parsed = JSON.parse(raw) as Record<string, boolean>;
        setTimeout(() => {
          if (live) setManual(parsed);
        }, 0);
      }
    } catch {
      // private window: the manual ticks simply do not persist
    }
    return () => {
      live = false;
    };
  }, []);

  const markDone = useCallback((id: string) => {
    setManual((prev) => {
      const next = { ...prev, [id]: true };
      try {
        localStorage.setItem(STORAGE, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const doneOf = (s: Step) =>
    s.isDone ? s.isDone(progress) : manual[s.id] === true;
  const completed = STEPS.filter(doneOf).length;
  const current = STEPS.find((s) => !doneOf(s)) ?? null;

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-5 px-4 py-8">
      <header className="flex flex-col gap-2">
        <p className="text-ink/50 font-mono text-xs uppercase">
          Metropolis · Onchain Finance &amp; Trading
        </p>
        <h1 className="text-ink text-2xl font-semibold">
          Cota, in eleven steps
        </h1>
        <p className="text-ink/70 text-sm leading-snug">
          This page watches what you actually do and moves on by itself. The
          first seven steps work on an empty wallet — including the one that
          matters, which is software refusing an instruction because of a number
          you signed.
        </p>
      </header>

      <div className="flex items-center gap-3">
        <div className="bg-hull-line h-1.5 flex-1 overflow-hidden rounded-full">
          <div
            className="bg-phosphor h-full rounded-full transition-all duration-500"
            style={{ width: `${(completed / STEPS.length) * 100}%` }}
          />
        </div>
        <p className="text-ink/60 shrink-0 font-mono text-xs">
          {completed}/{STEPS.length}
        </p>
      </div>

      {current === null ? (
        <Note tone="success" title="That is all of it">
          Eleven for eleven. The repository README and docs/ carry the same
          story with the code beside it.
        </Note>
      ) : null}

      {/* THE CURRENT STEP, AND ONLY IT.
          This page used to render all eleven at once with an expander each,
          which is a checklist however faithfully it tracks real state: it asks
          a judge to choose where to start and to carry the whole list in their
          head while they do. One step, one reason, one button — the rest is
          below for anyone who wants to audit the route rather than walk it. */}
      {current ? (
        <Panel className="space-y-3">
          <div>
            <p className="text-ink/50 font-mono text-[11px] tracking-[0.18em] uppercase">
              Step {completed + 1} of {STEPS.length} · {current.bounty}
            </p>
            <h2 className="text-ink mt-1 text-xl font-semibold">
              {current.title}
            </h2>
          </div>
          <p className="text-ink/80 text-sm leading-snug">{current.why}</p>
          <p className="text-ink/60 text-sm leading-snug">{current.action}</p>

          {current.gated?.(progress) ? (
            <Note tone="warn">
              This one waits on the previous step&rsquo;s money arriving. The
              page notices by itself when it does.
            </Note>
          ) : null}

          <a
            href={current.href}
            target={current.href.startsWith("http") ? "_blank" : undefined}
            rel={current.href.startsWith("http") ? "noreferrer" : undefined}
            className="bg-phosphor text-hull flex min-h-12 w-full items-center justify-center rounded-2xl px-5 text-sm font-semibold"
          >
            {current.href.startsWith("http")
              ? "Open on GitHub →"
              : "Take me there →"}
          </a>

          {/* Only for the steps nothing can observe. A step with isDone has no
              button here on purpose: a judge marking their own homework is the
              one thing this page exists not to do. */}
          {!current.isDone ? (
            <button
              type="button"
              onClick={() => markDone(current.id)}
              className="text-ink/60 w-full text-center text-xs underline underline-offset-2"
            >
              I&rsquo;ve read this — next step
            </button>
          ) : (
            <p className="text-ink/40 text-center text-[11px]">
              This advances on its own when you do it. Nothing to tick.
            </p>
          )}
        </Panel>
      ) : (
        <Panel className="space-y-2">
          <h2 className="text-ink text-xl font-semibold">
            That is all eleven.
          </h2>
          <p className="text-ink/70 text-sm leading-snug">
            Every number on this walkthrough came from production while you
            walked it. The record at /judge/record is the same table the
            executor writes to.
          </p>
          <a
            href="/judge/record"
            className="border-hull-line text-ink flex min-h-12 w-full items-center justify-center rounded-2xl border px-5 text-sm font-medium"
          >
            Read the refusals →
          </a>
        </Panel>
      )}

      <Disclosure
        title="All eleven steps"
        sub="The whole route, and what each one is for"
      >
        <ol className="flex flex-col gap-2">
          {STEPS.map((step, n) => {
            const done = doneOf(step);
            const isCurrent = current?.id === step.id;
            const expanded = isCurrent || open === step.id;
            const blocked = step.gated?.(progress) === true && !done;
            const external = step.href.startsWith("http");
            return (
              <li key={step.id}>
                <Panel
                  className={
                    isCurrent
                      ? "border-phosphor/50"
                      : done
                        ? "opacity-50"
                        : "opacity-80"
                  }
                >
                  <button
                    type="button"
                    onClick={() => setOpen(open === step.id ? null : step.id)}
                    className="flex w-full items-center gap-3 text-left"
                  >
                    <span
                      className={
                        done
                          ? "text-phosphor font-mono text-sm"
                          : "text-ink/40 font-mono text-sm"
                      }
                    >
                      {done ? "✓" : String(n + 1).padStart(2, "0")}
                    </span>
                    <span className="text-ink flex-1 text-sm font-medium">
                      {step.title}
                    </span>
                  </button>

                  {expanded ? (
                    <div className="mt-3 pl-7">
                      <p className="text-ink/50 text-xs">{step.bounty}</p>
                      <p className="text-ink/80 mt-2 text-sm leading-snug">
                        {step.why}
                      </p>
                      <p className="text-ink/60 mt-2 text-sm leading-snug">
                        {step.action}
                      </p>
                      {blocked ? (
                        <p className="text-ink/50 mt-2 text-xs">
                          Waiting on your deposit — step 8.
                        </p>
                      ) : null}
                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        <a
                          href={step.href}
                          target={external ? "_blank" : undefined}
                          rel={external ? "noreferrer" : undefined}
                          className={
                            isCurrent
                              ? "bg-phosphor/10 border-phosphor/40 text-ink inline-flex min-h-10 items-center rounded-xl border px-4 text-sm"
                              : "border-hull-line text-ink inline-flex min-h-10 items-center rounded-xl border px-4 text-sm"
                          }
                        >
                          {external ? "Open in GitHub →" : "Take me there →"}
                        </a>
                        {step.isDone === undefined && !done ? (
                          <button
                            type="button"
                            onClick={() => markDone(step.id)}
                            className="text-ink/60 text-xs underline"
                          >
                            I&apos;ve done this
                          </button>
                        ) : null}
                        {step.isDone !== undefined && !done ? (
                          <span className="text-ink/40 text-xs">
                            ticks itself when you do it
                          </span>
                        ) : null}
                      </div>
                      {step.id === "anchor" && progress.anchorTxHash ? (
                        <a
                          href={`https://monadscan.com/tx/${progress.anchorTxHash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-ink/50 mt-3 block font-mono text-xs break-all"
                        >
                          {progress.anchorTxHash}
                        </a>
                      ) : null}
                    </div>
                  ) : null}
                </Panel>
              </li>
            );
          })}
        </ol>
      </Disclosure>

      <Note title="If you would rather not spend anything">
        The first seven steps are the argument and cost nothing. The funding
        step exists because the last four genuinely move money on a live venue,
        and we would rather show you that than describe it.
      </Note>
    </main>
  );
}
