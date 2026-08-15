"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAuthSlot } from "@/app/providers";
import { shortAddress } from "@/components/hunt/format";
import { Button, LinkButton, Note } from "@/components/ui/primitives";

/* ---------------------------------------------------------------------------
   Sign-in surface.

   Session state is real — it comes from `GET /api/auth/session`. The sign-in
   ACTION is the auth lane's (Mera derives a key from the passkey's PRF output
   in the browser, so it cannot live server-side), and when it is not registered
   this panel says so instead of rendering a primary button that does nothing.
   A dead primary button is how a demo becomes an outage report.
--------------------------------------------------------------------------- */

export function SignInPanel() {
  const auth = useAuthSlot();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (auth.status === "loading") {
    return (
      <div className="border-hull-line bg-hull text-ink-dim min-h-14 rounded-2xl border p-4 text-center font-mono text-sm">
        Checking session…
      </div>
    );
  }

  if (auth.status === "blocked") {
    return (
      <div className="space-y-3">
        <Note tone="stop" title="Wallet not eligible">
          {shortAddress(auth.walletAddress)} is suspended or deactivated for the
          hunt. Claims and collects will be refused — talk to the organiser
          before walking anywhere.
        </Note>
        <Button tone="ghost" type="button" onClick={() => void auth.signOut()}>
          Sign out
        </Button>
      </div>
    );
  }

  if (auth.status === "signed-in") {
    return (
      <div className="space-y-3">
        <p className="text-ink-dim text-center font-mono text-sm">
          {auth.displayName ?? shortAddress(auth.walletAddress)}
        </p>
        <LinkButton href="/hunt" tone="primary">
          OPEN THE SCOPE
        </LinkButton>
        <Button
          tone="ghost"
          type="button"
          onClick={() => void auth.signOut()}
          className="text-base"
        >
          Sign out
        </Button>
      </div>
    );
  }

  const onSignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      await auth.signIn();
      auth.refresh();
      router.push("/hunt");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {auth.canSignIn ? (
        <>
          <Button type="button" onClick={() => void onSignIn()} disabled={busy}>
            {busy ? "WAITING…" : "CONTINUE WITH FACE ID"}
          </Button>
          <p className="text-ink-faint px-2 text-center text-xs leading-snug">
            A passkey lives in your phone&apos;s secure enclave. There is no
            seed phrase to lose and nothing to write down.
          </p>
        </>
      ) : (
        <Note title="Sign-in not available yet">
          The passkey flow is not registered in this build. The scope still runs
          — readings and spawns need a session, so they will show as signed-out
          until it lands.
        </Note>
      )}

      {error ? (
        <Note tone="warn" title="Not signed in">
          {error}
        </Note>
      ) : null}

      <LinkButton href="/hunt">Browse hunts</LinkButton>
    </div>
  );
}
