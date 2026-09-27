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

type Part = "open" | "fund" | "funded";

interface Item {
  id: string;
  bounty: string;
  sponsor: string;
  /** What actually satisfies it, in one line. */
  claim: string;
  /** What the judge should do to see it. */
  todo: string;
  href: string;
  part: Part;
}

const PART_HEADING: Record<Part, string> = {
  open: "Works right now, on an empty wallet",
  fund: "Fund yourself — this is the Aurora bounty, and it unlocks the rest",
  funded: "Once your deposit has landed",
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
    part: "open",
  },
  {
    id: "leash",
    bounty: "Best use of Perpl's API",
    sponsor: "Perpl",
    claim:
      "A signed EIP-712 bound is the agent's entire authority. Checked before every order, fails closed, over a key Perpl will not let withdraw.",
    todo: "Set your limits on the Cota form and sign them. The signature costs nothing — it never touches the chain.",
    href: "/cota",
    part: "open",
  },
  {
    id: "record",
    bounty: "The refusal — the point of the product",
    sponsor: "read this one even if you skip the rest",
    claim:
      "On 4 September the live agent asked one bound for four trades inside the same second. It allowed one and refused three: a market the bound did not authorise, then leverage, then size. Three ceilings, one leash, no staging.",
    todo: "Open the production record. These are rows the executor wrote — a refusal there means the order never reached the venue. Four real fills on Perpl are listed underneath.",
    href: "/judge/record",
    part: "open",
  },
  {
    id: "prf",
    bounty: "Mera: One Passkey, Many Keys",
    sponsor: "Monad Foundation",
    claim:
      "A second PRF salt derives a non-extractable AES-GCM key that is not a wallet and signs nothing. It seals your private note about a leash, as ciphertext this server cannot read.",
    todo: "Write a note against your leash. Then clear site data and sign in again — it decrypts, because the key came from your passkey and was never stored.",
    href: "/cota/trade",
    part: "open",
  },
  {
    id: "kimi",
    bounty: "Best Builds Powered by KIMI",
    sponsor: "Kimi",
    claim:
      "The agent's trade proposals come from KIMI (api.moonshot.ai, model kimi-k2.6). Every proposal is then checked against your signed bound before it can reach the venue.",
    todo: "Read lib/cota/propose.ts — the model proposes, the leash disposes.",
    href: "https://github.com/EmpowerTours/empowertours-hunt/blob/master/lib/cota/propose.ts",
    part: "open",
  },
  {
    id: "cre",
    bounty: "Best workflow with CRE",
    sponsor: "Chainlink",
    claim:
      "A Chainlink Runtime Environment workflow as the agent's scheduler — main.ts, workflow.yaml, staging and production config, and a recorded CRE-CLI simulation run.",
    todo: "Read cre/agent-scheduler/, including SIMULATION.md.",
    href: "https://github.com/EmpowerTours/empowertours-hunt/tree/master/cre/agent-scheduler",
    part: "open",
  },
  {
    id: "agora",
    bounty: "Best Mobile Trading App on Monad",
    sponsor: "Agora",
    claim:
      "Mera passkey auth, an AUSD balance and Perpl trades — on the web, as an Android APK, and on iOS through TestFlight. The same passkey yields the same address in all three.",
    todo: "Open this on a phone and add it to your home screen, or install the APK.",
    href: "/download",
    part: "open",
  },
  {
    id: "aurora",
    bounty: "Bring Any-Chain Liquidity to Monad",
    sponsor: "Aurora Intents",
    claim:
      "One permanent address per hunter, accepting twelve EVM chains and dozens of assets, delivering MON on Monad — so a newcomer can pay their own gas the moment they arrive.",
    todo: "Take your deposit address and send a few dollars from any chain on the list. A real 2 USDC transfer from Base settled in 14 seconds; watch yours appear in the arrivals list. About $12 covers everything below — $2 is enough for gas and the swap, and Perpl needs 10 AUSD to open an account.",
    href: "/cota/onramp",
    part: "fund",
  },
  {
    id: "anchor",
    bounty: "The bound, on chain",
    sponsor: "verifiable by anyone, not just by us",
    claim:
      "Anchoring writes your leash digest to AuditAnchorV2 from your own wallet, so the bound stops resting on our database and starts resting on a chain event.",
    todo: "Anchor the leash you signed earlier and open the transaction on MonadScan. It is your address, your digest.",
    href: "/cota",
    part: "funded",
  },
  {
    id: "swap",
    bounty: "Build the Next Consumer Trading App on Kuru",
    sponsor: "Kuru",
    claim:
      "MON → AUSD routes through Kuru's on-chain order book and a Uniswap v4 pool, with the book crossing verified from the transaction's own logs.",
    todo: "Swap the MON that arrived into AUSD — the collateral Perpl settles in.",
    href: "/cota/swap",
    part: "funded",
  },
  {
    id: "spot",
    bounty: "Spot trading, no leverage, no Perpl account",
    sponsor: "Kuru",
    claim:
      "MON ↔ USDC on Kuru's order book, both directions, for anyone who wants exposure without a leash or a venue account.",
    todo: "Trade spot in either direction.",
    href: "/cota/spot",
    part: "funded",
  },
  {
    id: "risk",
    bounty: "Best Analytics / Risk Tool",
    sponsor: "Perpl",
    claim:
      "Live exposure, leverage and distance-to-ceiling for a leashed account, read from Perpl rather than from our own table.",
    todo: "Deposit your AUSD into Perpl, place a trade under your leash, then open the risk screen and watch the distance to your own ceiling.",
    href: "/cota/deposit",
    part: "funded",
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
          Twelve things to do, each naming the bounty it answers. The first
          seven work on an empty wallet, including the one that matters — the
          software refusing an instruction because of a number you signed. The
          eighth funds you from any chain, and the rest open up once it lands.
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

      {(["open", "fund", "funded"] as const).map((part) => (
        <section key={part} className="flex flex-col gap-3">
          <h2 className="text-ink/60 border-hull-line border-b pb-1 text-xs uppercase">
            {PART_HEADING[part]}
          </h2>
          <ol className="flex flex-col gap-3">
            {ITEMS.filter((i) => i.part === part).map((item) => {
              const external = item.href.startsWith("http");
              const n = ITEMS.indexOf(item) + 1;
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
                        {done[item.id] ? "\u2713" : ""}
                      </button>
                      <div className="min-w-0 flex-1">
                        <p className="text-ink text-sm font-medium">
                          {n}. {item.bounty}
                        </p>
                        <p className="text-ink/50 text-xs">{item.sponsor}</p>
                        <p className="text-ink/80 mt-2 text-sm leading-snug">
                          {item.claim}
                        </p>
                        <p className="text-ink/60 mt-2 text-sm leading-snug">
                          {item.todo}
                        </p>
                        <a
                          href={item.href}
                          target={external ? "_blank" : undefined}
                          rel={external ? "noreferrer" : undefined}
                          className="border-hull-line text-ink mt-3 inline-flex min-h-10 items-center rounded-xl border px-4 text-sm"
                        >
                          {external ? "Open in GitHub \u2192" : "Open \u2192"}
                        </a>
                      </div>
                    </div>
                  </Panel>
                </li>
              );
            })}
          </ol>
        </section>
      ))}

      <Note title="If you would rather not spend anything">
        The first seven items are the argument, and they cost nothing. The
        funding step exists because the last four genuinely move money on a live
        venue, and we would rather show you that than describe it.
      </Note>

      <a href="/cota" className="text-ink/60 text-sm">
        ← Start at the Cota screen
      </a>
    </main>
  );
}
