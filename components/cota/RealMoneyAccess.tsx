"use client";

// The screen half of the real-money gate. The server half is
// lib/cota/real-money.ts and is the one that actually refuses: every money
// route checks the allowlist itself. This file only keeps a hunter who is not on
// the list from being walked into a flow that would be refused, and stops the
// browser-signed flows (desk swap, Kuru, Perpl deposit, bridge) from being
// offered at all, since those never pass through our server.

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { useAuthSlot } from "@/app/providers";
import { Note } from "@/components/ui/primitives";
import { REAL_MONEY_CLOSED_TEXT } from "@/lib/cota/real-money";

export type RealMoneyAccess = "loading" | "open" | "closed" | "signed-out";

/**
 * Whether the signed-in hunter may use real-money Cota, from /api/cota/access.
 * Any failure to read it reads as "closed".
 */
export function useRealMoneyAccess(): RealMoneyAccess {
  const auth = useAuthSlot();
  // The answer, tagged with the wallet it was asked for, so a wallet switch
  // reads as "loading" until its own answer arrives.
  const [answer, setAnswer] = useState<{
    wallet: string | null;
    open: boolean;
  } | null>(null);
  const signedIn = auth.status === "signed-in";

  useEffect(() => {
    if (!signedIn) return;
    const wallet = auth.walletAddress;
    const ac = new AbortController();
    fetch("/api/cota/access", { cache: "no-store", signal: ac.signal })
      .then((r) => (r.ok ? r.json() : { realMoney: false }))
      .then((b: { realMoney?: unknown }) =>
        setAnswer({ wallet, open: b.realMoney === true }),
      )
      .catch(() => {
        if (!ac.signal.aborted) setAnswer({ wallet, open: false });
      });
    return () => ac.abort();
  }, [signedIn, auth.walletAddress]);

  if (auth.status === "loading") return "loading";
  if (auth.status === "signed-out") return "signed-out";
  if (!signedIn) return "closed"; // blocked
  if (answer === null || answer.wallet !== auth.walletAddress) return "loading";
  return answer.open ? "open" : "closed";
}

/** "Real-money trading is closed for now." */
export function RealMoneyClosedNotice() {
  const lang = useLocale() === "es" ? "es" : "en";
  return (
    <div role="status" data-testid="real-money-closed">
      <Note tone="warn">{REAL_MONEY_CLOSED_TEXT[lang]}</Note>
    </div>
  );
}

/**
 * For a screen whose only purpose is moving money in (swap, deposit, bridge,
 * on-ramp, key enrolment): shows the notice instead of the screen to a hunter
 * who is not allowlisted. Signed out, the screen renders as before so its own
 * sign-in prompt shows; every action on it still needs a session.
 */
export function RealMoneyGate({ children }: { children: React.ReactNode }) {
  const access = useRealMoneyAccess();
  if (access === "loading") return null;
  if (access === "closed") {
    return (
      <main className="mx-auto max-w-md px-4 py-6">
        <RealMoneyClosedNotice />
      </main>
    );
  }
  return <>{children}</>;
}
