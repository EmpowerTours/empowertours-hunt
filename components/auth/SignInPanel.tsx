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
  const [offerCreate, setOfferCreate] = useState(false);

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

  const run = async (kind: "sign-in" | "create") => {
    setBusy(true);
    setError(null);
    try {
      await (kind === "create" ? auth.createWallet() : auth.signIn());
      auth.refresh();
      router.push("/hunt");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Sign-in failed.");
      // Only a failed ASSERTION offers to create. A failed create must not
      // re-offer itself, or a player whose device cannot make passkeys at all
      // taps the same dead button forever.
      setOfferCreate(kind === "sign-in" && isNoPasskeyFound(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {auth.canSignIn ? (
        <>
          <Button
            type="button"
            onClick={() => void run("sign-in")}
            disabled={busy}
          >
            {busy ? "WAITING…" : "CONTINUE WITH YOUR PHONE"}
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

      {/* Shown only after an assertion found nothing on this phone. The label
          says what the button does, because the alternative — a wallet appearing
          because the player tapped sign-in a third time — is how someone with a
          passkey on another device ends up with two wallets and half a balance. */}
      {offerCreate ? (
        <Button
          tone="primary"
          type="button"
          onClick={() => void run("create")}
          disabled={busy}
        >
          {busy ? "WAITING…" : "MAKE A NEW HUNT WALLET"}
        </Button>
      ) : null}

      <LinkButton href="/hunt">Browse hunts</LinkButton>
    </div>
  );
}

/**
 * Structural, not textual: NoPasskeyFoundError sets this flag, and matching on
 * the flag means the copy can be rewritten (or translated) without silently
 * removing the only way a first-time player reaches a wallet.
 */
function isNoPasskeyFound(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { canCreateWallet?: unknown }).canCreateWallet === true
  );
}
