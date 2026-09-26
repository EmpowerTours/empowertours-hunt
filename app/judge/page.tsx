"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuthSlot } from "@/app/providers";
import { Note, Panel } from "@/components/ui/primitives";

// ---------------------------------------------------------------------------
// The judge's walkthrough.
//
// A submission form gets a "login instructions" field and most teams fill it
// with a paragraph. A paragraph makes a judge READ. This makes them DO: one row
// per bounty, each naming what satisfies it and linking to the screen that
// proves it, with a tick they can leave behind.
//
// WRITTEN IN ENGLISH ON PURPOSE, while the product itself opens in Spanish.
// That is not an oversight to apologise for — the players are in Guerrero and
// the app is built for them. This page is the one surface written for the
// reader rather than the user.
//
// EVERY "no funds" CLAIM HERE IS LOAD-BEARING, so each one was checked against
// the code rather than assumed:
//   - Signing a leash never touches the chain. `Cota.anchorTxHash` is nullable
//     and app/api/cota/route.ts sets it only when the client supplies one, so
//     the leash is valid whether or not the anchor ever lands. lib/cota/
//     anchor.ts says the same: "a failure here never invalidates the signed
//     leash."
//   - Practice trades against live Perpl marks through lib/cota/enforce.ts —
//     the SAME function the live path calls, not a copy of it.
// So a judge with an empty wallet can reach the refusal, which is the one
// screen this whole product exists to produce.
// ---------------------------------------------------------------------------

type Cost = "free" | "gas" | "funds";

interface Item {
  id: string;
  bounty: string;
  sponsor: string;
  /** What actually satisfies it, in one line. */
  claim: string;
  /** What the judge should do to see it. */
  todo: string;
  href: string;
  cost: Cost;
}

const COST_LABEL: Record<Cost, string> = {
  free: "no wallet funds needed",
  gas: "needs a little MON for gas",
  funds: "needs funded AUSD",
};

const ITEMS: Item[] = [
  {
    id: "mera-ux",
    bounty: "Best Mera-Powered UX on Monad",
    sponsor: "Monad Foundation",
    claim:
      "Mera is the entire account layer. The embedded-wallet SDK was deleted, not disabled — there is no other way in.",
    todo: "Tap sign in. One Face ID / Touch ID prompt and you hold a Monad wallet. Then clear this site's data and sign in again: the same address comes back, reconstructed from the passkey alone.",
    href: "/cota",
    cost: "free",
  },
  {
    id: "leash",
    bounty: "Best use of Perpl's API",
    sponsor: "Perpl",
    claim:
      "A signed EIP-712 bound is the agent's entire authority. Checked before every order, fails closed, over a key Perpl will not let withdraw.",
    todo: "Set your limits on the Cota form and sign them. No chain transaction is required for the signature — anchoring is a separate, optional act.",
    href: "/cota",
    cost: "free",
  },
  {
    id: "refusal",
    bounty: "The refusal — the point of the product",
    sponsor: "read this one even if you skip the rest",
    claim:
      "lib/cota/enforce.ts is a pure function: no clock, no database, no network. Practice trades run through that same function, not a copy.",
    todo: "In practice mode, try to open a position bigger than the size you signed, or keep trading after your daily loss ceiling. It refuses, and names the number you hit. Neither you nor we can override it.",
    href: "/cota/practice",
    cost: "free",
  },
  {
    id: "aurora",
    bounty: "Bring Any-Chain Liquidity to Monad",
    sponsor: "Aurora Intents",
    claim:
      "A permanent deposit address per hunter, accepting 12 EVM chains and dozens of assets, delivering MON on Monad so a newcomer can pay their own gas on arrival.",
    todo: "Open the funding screen and take your address. A real 2 USDC deposit from Base settled on Monad in 14 seconds — departure and arrival both show in the arrivals list.",
    href: "/cota/onramp",
    cost: "free",
  },
  {
    id: "kuru",
    bounty: "Build the Next Consumer Trading App on Kuru",
    sponsor: "Kuru",
    claim:
      "Spot MON ↔ USDC routed through Kuru's on-chain order book, both directions, with the book crossing verified from the transaction's own logs.",
    todo: "Open the spot screen. Quotes are live; trading needs a funded wallet.",
    href: "/cota/spot",
    cost: "funds",
  },
  {
    id: "agora",
    bounty: "Best Mobile Trading App on Monad",
    sponsor: "Agora",
    claim:
      "Mera passkey auth, an AUSD balance, and trades executed through Perpl — on the web, as an Android APK, and on iOS through TestFlight. The same passkey yields the same address in all three.",
    todo: "Use this on a phone. Add it to your home screen, or install the APK from the download page.",
    href: "/download",
    cost: "free",
  },
  {
    id: "risk",
    bounty: "Best Analytics / Risk Tool",
    sponsor: "Perpl",
    claim:
      "Live exposure, leverage and distance-to-ceiling for a leashed account, read from Perpl rather than from our own table.",
    todo: "Open the risk screen. It is most meaningful on a funded account, but the layout and the numbers it pulls are visible either way.",
    href: "/cota/risk",
    cost: "free",
  },
  {
    id: "kimi",
    bounty: "Best Builds Powered by KIMI",
    sponsor: "Kimi",
    claim:
      "The agent's trade proposals come from KIMI (api.moonshot.ai, model kimi-k2.6). Every proposal is then checked against the signed bound before it can reach the venue.",
    todo: "Read lib/cota/propose.ts in the repo — the model proposes, the leash disposes.",
    href: "https://github.com/EmpowerTours/empowertours-hunt/blob/master/lib/cota/propose.ts",
    cost: "free",
  },
  {
    id: "cre",
    bounty: "Best workflow with CRE",
    sponsor: "Chainlink",
    claim:
      "A Chainlink Runtime Environment workflow as the agent's scheduler — main.ts, workflow.yaml, staging and production config, and a recorded CRE-CLI simulation run.",
    todo: "Read cre/agent-scheduler/ in the repo, including SIMULATION.md.",
    href: "https://github.com/EmpowerTours/empowertours-hunt/tree/master/cre/agent-scheduler",
    cost: "free",
  },
  {
    id: "prf",
    bounty: "Mera: One Passkey, Many Keys",
    sponsor: "Monad Foundation",
    claim:
      "A second PRF salt derives a non-extractable AES-GCM key that is not a wallet and signs nothing. It seals a hunter's private note about a leash, as ciphertext this server cannot read.",
    todo: "On the trade screen, write a note against a leash. Then clear site data and sign in on a fresh profile: the note decrypts again, because the key came from the passkey and was never stored.",
    href: "/cota/trade",
    cost: "free",
  },
];

const STORAGE = "judge.checklist.v1";

export default function JudgePage() {
  const auth = useAuthSlot();
  const [done, setDone] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let live = true;
    try {
      const raw = localStorage.getItem(STORAGE);
      if (raw !== null) {
        const parsed = JSON.parse(raw) as Record<string, boolean>;
        // Deferred a tick: reading storage during render commit is what the
        // lint objects to, and a checklist that flickers once is fine.
        setTimeout(() => {
          if (live) setDone(parsed);
        }, 0);
      }
    } catch {
      // A private window refuses storage. The list still works, it just does
      // not remember — which is a nicety, not the feature.
    }
    return () => {
      live = false;
    };
  }, []);

  const toggle = useCallback((id: string) => {
    setDone((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem(STORAGE, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const completed = ITEMS.filter((i) => done[i.id]).length;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-8">
      <header className="flex flex-col gap-2">
        <p className="text-ink/50 font-mono text-xs uppercase">
          Metropolis · Onchain Finance &amp; Trading
        </p>
        <h1 className="text-ink text-2xl font-semibold">
          Cota — a walkthrough for judges
        </h1>
        <p className="text-ink/70 text-sm leading-snug">
          Ten things to try, each naming the bounty it answers. Most need no
          money at all — including the one that matters, which is watching the
          software refuse an instruction because of a number you signed.
        </p>
      </header>

      <Note>
        <strong>Signing in takes one tap.</strong> There is no email, no seed
        phrase, no extension and no app install: a passkey prompt gives you a
        Monad wallet, and the wallet <em>is</em> the passkey. The product opens
        in Spanish because its players are in Guerrero, Mexico — there is a
        language switch on every screen.
      </Note>

      <div className="flex items-center justify-between">
        <p className="text-ink/60 text-xs uppercase">
          {completed} of {ITEMS.length} done
        </p>
        <p className="text-ink/50 text-xs">
          {auth.status === "signed-in" ? "signed in" : "not signed in yet"}
        </p>
      </div>

      <ol className="flex flex-col gap-3">
        {ITEMS.map((item, n) => {
          const external = item.href.startsWith("http");
          return (
            <li key={item.id}>
              <Panel className={done[item.id] ? "opacity-60" : ""}>
                <div className="flex items-start gap-3">
                  <button
                    type="button"
                    onClick={() => toggle(item.id)}
                    aria-pressed={done[item.id] === true}
                    aria-label={`Mark "${item.bounty}" as done`}
                    className="border-hull-line mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-sm"
                  >
                    {done[item.id] ? "✓" : ""}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="text-ink text-sm font-medium">
                      {n + 1}. {item.bounty}
                    </p>
                    <p className="text-ink/50 text-xs">{item.sponsor}</p>
                    <p className="text-ink/80 mt-2 text-sm leading-snug">
                      {item.claim}
                    </p>
                    <p className="text-ink/60 mt-2 text-sm leading-snug">
                      {item.todo}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <a
                        href={item.href}
                        target={external ? "_blank" : undefined}
                        rel={external ? "noreferrer" : undefined}
                        className="border-hull-line text-ink inline-flex min-h-10 items-center rounded-xl border px-4 text-sm"
                      >
                        {external ? "Open in GitHub →" : "Open →"}
                      </a>
                      <span className="text-ink/50 text-xs">
                        {COST_LABEL[item.cost]}
                      </span>
                    </div>
                  </div>
                </div>
              </Panel>
            </li>
          );
        })}
      </ol>

      <Note tone="warn" title="What you cannot do without funds">
        Opening a real Perpl position needs AUSD, and swapping needs a little
        MON for gas. Everything above marked otherwise works on an empty wallet
        — including practice, which trades against live Perpl prices through the
        same enforcement code as the live path.
      </Note>

      <a href="/cota" className="text-ink/60 text-sm">
        ← Start at the Cota screen
      </a>
    </main>
  );
}
