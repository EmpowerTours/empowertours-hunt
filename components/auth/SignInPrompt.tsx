"use client";

import { useState } from "react";
import { useLocale } from "next-intl";
import { useAuthSlot } from "@/app/providers";
import { Button, Note } from "@/components/ui/primitives";

/* ---------------------------------------------------------------------------
   Sign in, and — when this device holds no passkey — offer to make a wallet.

   This exists because the two halves had drifted apart. `SignInPanel` on the
   hunt landing page learned to offer "MAKE A NEW HUNT WALLET" after a failed
   assertion; every Cota screen kept calling `auth.signIn()` directly. So the
   error text promised "or make a new wallet below" and there was nothing below
   it — a dead end wearing an instruction, reported from a real phone.

   Most of those call sites were `void auth.signIn()`, which discards the
   rejection entirely: the ceremony failed, nothing appeared, and the screen sat
   there looking broken. That is the worse half of the bug, because it is
   silent.

   One component, so the next screen that needs a sign-in button cannot
   reintroduce either. It owns the whole outcome: the prompt, the error, and the
   way forward.
--------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
   Creating is not recovering, and the button cannot say so by itself.

   The wallet IS the passkey: the PRF output for (credential, rpId, salt) is fed
   through BIP-39 to a key. A second credential is therefore a second WALLET
   with a different address and a different balance — not another way into the
   first one. Someone who made a wallet in Chrome and is now looking at this
   screen inside the app is exactly the person most likely to tap it, because
   from where they sit both say "sign in and nothing happened".

   So the offer carries the consequence next to it, and a route that does work.
--------------------------------------------------------------------------- */
const CREATE_WARNING = {
  en: {
    title: "This makes a NEW wallet",
    body: "If you already made a wallet on this phone — in Chrome, or on the hunt — do not tap this. It creates a second, different wallet with its own balance; it cannot reach the first one. Open the same browser you first signed in with, or run /diag on this device to see why the passkey is not being found.",
  },
  es: {
    title: "Esto crea una cartera NUEVA",
    body: "Si ya creaste una cartera en este teléfono — en Chrome, o en la búsqueda — no toques esto. Crea una segunda cartera distinta, con su propio saldo; no puede llegar a la primera. Abre el mismo navegador donde entraste la primera vez, o abre /diag en este dispositivo para ver por qué no encuentra la llave.",
  },
} as const;

/**
 * Structural, not textual: NoPasskeyFoundError carries this flag. Matching on
 * it means the copy can be rewritten or translated without silently removing
 * the only route a first-time player has to a wallet.
 */
function offersCreate(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { canCreateWallet?: unknown }).canCreateWallet === true
  );
}

export function SignInPrompt({
  label,
  createLabel = "MAKE A NEW WALLET",
  onSignedIn,
  className = "",
}: {
  label: string;
  createLabel?: string;
  /** Called after a sign-in or a create succeeds. */
  onSignedIn?: () => void;
  className?: string;
}) {
  const auth = useAuthSlot();
  const warn = CREATE_WARNING[useLocale() === "es" ? "es" : "en"];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The ceremony's own error, shown verbatim: this is what gets screenshotted. */
  const [detail, setDetail] = useState<string | null>(null);
  const [offerCreate, setOfferCreate] = useState(false);

  const run = async (kind: "sign-in" | "create") => {
    setBusy(true);
    setError(null);
    setDetail(null);
    try {
      await (kind === "create" ? auth.createWallet() : auth.signIn());
      auth.refresh();
      onSignedIn?.();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Sign-in failed.");
      const d =
        typeof e === "object" && e !== null
          ? (e as { detail?: unknown }).detail
          : undefined;
      setDetail(typeof d === "string" && d.length > 0 ? d : null);
      // Only a failed ASSERTION offers to create. A failed create must not
      // re-offer itself, or someone whose device cannot make passkeys at all
      // taps the same dead button forever.
      setOfferCreate(kind === "sign-in" && offersCreate(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`space-y-3 ${className}`}>
      <Button
        type="button"
        onClick={() => void run("sign-in")}
        disabled={busy || !auth.canSignIn}
      >
        {busy ? "WAITING…" : label}
      </Button>

      {error ? (
        <Note tone="warn" title="Not signed in">
          {error}
          {detail ? (
            <span className="text-ink-faint mt-2 block font-mono text-xs break-words">
              {detail}
            </span>
          ) : null}
        </Note>
      ) : null}

      {offerCreate ? (
        <Note tone="warn" title={warn.title}>
          {warn.body}
        </Note>
      ) : null}

      {offerCreate ? (
        <Button
          tone="primary"
          type="button"
          onClick={() => void run("create")}
          disabled={busy}
        >
          {busy ? "WAITING…" : createLabel}
        </Button>
      ) : null}
    </div>
  );
}
