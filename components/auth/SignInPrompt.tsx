"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { useAuthSlot } from "@/app/providers";
import { Button, Note } from "@/components/ui/primitives";
import { inAppWebView } from "@/lib/app-shell";

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

/* ---------------------------------------------------------------------------
   What "WAITING…" means, while it means it.

   The ceremony is given 60s, guarded at 75s (lib/auth/passkey.ts), because a
   player outdoors picking a passkey off a system sheet needs that room and
   cutting it short would break a working sign-in to make a broken one fail
   faster. But for 75 seconds the button said "WAITING…" and nothing else, which
   is indistinguishable from a frozen app — and that is exactly the window in
   which someone force-quits and reports it as a hang.

   So the wait counts, and after a few seconds it says what should have happened
   by now. A sheet that never appeared is itself the diagnosis: the request went
   to the system and nothing answered it.
--------------------------------------------------------------------------- */
const WAITING = {
  en: {
    title: "Still waiting",
    hint: "Your phone should be showing a passkey sheet. If nothing appeared, the request reached the system and got no answer — wait for it to finish and the reason will show here.",
    elapsed: (s: number) => `waiting ${s}s`,
  },
  es: {
    title: "Aún esperando",
    hint: "Tu teléfono debería mostrar una hoja de llave de acceso. Si no apareció nada, la solicitud llegó al sistema y nadie respondió — espera a que termine y aquí aparecerá el motivo.",
    elapsed: (s: number) => `esperando ${s}s`,
  },
} as const;

/* ---------------------------------------------------------------------------
   The way to the diagnostic, from the screen where people need it.

   /diag was built to answer "why can't this device sign in" without a cable,
   and then linked only from /download — which the app never shows, because it
   opens straight onto Cota. So the one person holding the failing phone had no
   route to it and the copy below cheerfully told them to "open /diag" as though
   that were a thing you can do inside a WebView with no address bar.

   A link, next to the failure, where the failure happened.
--------------------------------------------------------------------------- */
const DIAG = {
  en: "Sign-in not working? Run diagnostics →",
  es: "¿No entra? Abre el diagnóstico →",
} as const;

/* ---------------------------------------------------------------------------
   The way out, on a phone whose app cannot reach its own credential manager.

   Measured on a vivo running OriginOS 6: Chrome signs in and reaches the wallet,
   the app gets NotReadableError in three seconds, and the same APK works on a
   Xiaomi. So for some devices the app is a dead end and the browser is not —
   and the app was telling those people nothing, which leaves them believing
   their wallet is gone when it is one tap away in Chrome.

   Deliberately TEXT, not a button. A link to our own origin stays inside the
   WebView (it is in allowNavigation, as it must be), and whether window.open
   escapes to the system browser is a Capacitor detail that varies — offering a
   button that silently reloads the same dead screen would be a second dead end
   wearing a way out. The instruction always works.
--------------------------------------------------------------------------- */
const USE_BROWSER = {
  en: {
    title: "Try your browser instead",
    body: "Some phones will not let an installed app reach the passkey, even though the phone holds it. Your wallet is not lost. Open Chrome and go to cota.empowertours.xyz — the same passkey, the same wallet, and sign-in works there.",
  },
  es: {
    title: "Prueba con el navegador",
    body: "Algunos teléfonos no dejan que una app instalada llegue a la llave de acceso, aunque el teléfono la tenga. Tu cartera no se perdió. Abre Chrome y entra a cota.empowertours.xyz — la misma llave, la misma cartera, y ahí sí entra.",
  },
} as const;

/** After this many seconds with no system sheet, saying so is more use than silence. */
const HINT_AFTER_S = 6;

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
  const locale = useLocale() === "es" ? "es" : "en";
  const warn = CREATE_WARNING[locale];
  const waiting = WAITING[locale];
  const diagLabel = DIAG[locale];
  const useBrowser = USE_BROWSER[locale];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The ceremony's own error, shown verbatim: this is what gets screenshotted. */
  const [detail, setDetail] = useState<string | null>(null);
  const [offerCreate, setOfferCreate] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const tick = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  // One interval for as long as a ceremony is open, cleared on every exit —
  // including unmount, which a player navigating away mid-prompt will do.
  useEffect(() => {
    if (!busy) {
      if (tick.current !== undefined) clearInterval(tick.current);
      tick.current = undefined;
      return;
    }
    tick.current = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => {
      if (tick.current !== undefined) clearInterval(tick.current);
      tick.current = undefined;
    };
  }, [busy]);

  const run = async (kind: "sign-in" | "create") => {
    setBusy(true);
    setError(null);
    setDetail(null);
    setElapsed(0);
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
        {busy ? `${waiting.elapsed(elapsed)}…` : label}
      </Button>

      {busy && elapsed >= HINT_AFTER_S ? (
        <Note tone="warn" title={waiting.title}>
          {waiting.hint}
        </Note>
      ) : null}

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

      {error !== null && inAppWebView() ? (
        <Note tone="warn" title={useBrowser.title}>
          {useBrowser.body}
        </Note>
      ) : null}

      {error !== null || (busy && elapsed >= HINT_AFTER_S) ? (
        <a
          href="/diag"
          className="text-ink-dim hover:text-ink block text-center text-xs underline underline-offset-4"
        >
          {diagLabel}
        </a>
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
          {busy ? `${waiting.elapsed(elapsed)}…` : createLabel}
        </Button>
      ) : null}
    </div>
  );
}
