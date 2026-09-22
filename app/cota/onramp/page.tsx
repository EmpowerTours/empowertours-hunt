"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { useAuthSlot } from "@/app/providers";
import { Button, Note, Panel } from "@/components/ui/primitives";
import { SignInPrompt } from "@/components/auth/SignInPrompt";

// ---------------------------------------------------------------------------
// Funding from any chain — one address, no wallet to connect.
//
// This is the door for a hunter whose money is not on Monad and is not AUSD.
// /cota/swap needs MON they hunted; /cota/bridge needs AUSD they already hold
// AND a wallet connected on the source chain. Someone holding SOL, BTC, USDC on
// Base, or a balance sitting on an exchange could not use either. Here they are
// given an address and send whatever they have from wherever it is.
//
// WHAT THIS PAGE DELIBERATELY DOES NOT DO:
//
//   - It does not ask for an amount. A persistent deposit address is a mailbox,
//     not a quote: no amount, no deadline, nothing to go stale. Asking would
//     imply a commitment that does not exist.
//   - It does not promise AUSD. Aurora carries no AUSD on any chain, so this
//     lands USDC on Monad and the hunter still walks the USDC->AUSD leg at
//     /cota/swap. Saying otherwise would be the kind of half-true that gets
//     somebody stuck holding a token they cannot use.
//   - It does not claim a deposit arrived. Until real money has moved through
//     one of these addresses the row shape coming back from Aurora is a guess
//     (see parsePersistentDeposits), so an empty list is rendered as "nothing
//     readable yet", never as "nothing was sent".
// ---------------------------------------------------------------------------

type Lang = "es" | "en";

interface AddressState {
  address: string | null;
  depositChain: string;
  recipient?: string;
}

const COPY = {
  es: {
    title: "Fondear desde cualquier red",
    lead: "Te damos una dirección. Envía lo que tengas, desde donde lo tengas — otra red EVM, un exchange, tu wallet. Llega como USDC en Monad.",
    get: "Dame mi dirección",
    working: "Pidiendo…",
    yours: "Tu dirección de depósito",
    permanent:
      "Es permanente. Es tuya, no caduca, y puedes volver a usarla siempre.",
    lands: "Los fondos llegan a tu wallet de Monad:",
    notAusd:
      "Llega como USDC, no como AUSD. Perpl cobra en AUSD, así que después pasa por Cambiar USDC → AUSD. Aurora no mueve AUSD en ninguna red.",
    copy: "Copiar",
    copied: "Copiado",
    unconfigured:
      "Esta ruta no está disponible ahora mismo. Usa las otras opciones para fondear.",
    upstream:
      "Aurora no respondió. Tu dirección, si ya tienes una, sigue siendo válida — vuelve a intentarlo.",
    swap: "Cambiar USDC → AUSD →",
    back: "← Cota",
  },
  en: {
    title: "Fund from any chain",
    lead: "We give you an address. Send whatever you hold, from wherever it sits — another EVM chain, an exchange, your wallet. It arrives as USDC on Monad.",
    get: "Give me my address",
    working: "Asking…",
    yours: "Your deposit address",
    permanent:
      "It is permanent. It is yours, it does not expire, and you can reuse it forever.",
    lands: "Funds land in your Monad wallet:",
    notAusd:
      "This arrives as USDC, not AUSD. Perpl settles in AUSD, so you still walk Swap USDC → AUSD afterwards. Aurora carries no AUSD on any chain.",
    copy: "Copy",
    copied: "Copied",
    unconfigured:
      "This route is not available right now. Use the other funding options.",
    upstream:
      "Aurora did not answer. Any address you already have is still valid — try again.",
    swap: "Swap USDC → AUSD →",
    back: "← Cota",
  },
} as const;

export default function OnrampPage() {
  const lang = (useLocale() as Lang) ?? "en";
  const t = COPY[lang] ?? COPY.en;
  const auth = useAuthSlot();
  const signedIn = auth.status === "signed-in";

  const [state, setState] = useState<AddressState | null>(null);
  const [error, setError] = useState<"unconfigured" | "upstream" | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // A GET never calls Aurora — it only reads what we already issued — so this
  // is safe to run on open and tells us both the address and whether the route
  // is configured at all.
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/cota/aurora", { cache: "no-store" });
        if (!live) return;
        if (res.status === 503) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setError(body.error === "unconfigured" ? "unconfigured" : "upstream");
          return;
        }
        if (!res.ok) return;
        setState((await res.json()) as AddressState);
      } catch {
        if (live) setError("upstream");
      }
    })();
    return () => {
      live = false;
    };
  }, [signedIn]);

  const issue = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/cota/aurora", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.status === 503) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error === "unconfigured" ? "unconfigured" : "upstream");
        return;
      }
      if (!res.ok) {
        setError("upstream");
        return;
      }
      setState((await res.json()) as AddressState);
    } catch {
      setError("upstream");
    } finally {
      setBusy(false);
    }
  }, []);

  const address = state?.address ?? null;
  const copy = useCallback(async () => {
    if (address == null) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // A browser that refuses the clipboard still shows the address on screen.
    }
  }, [address]);

  if (!signedIn) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 py-6">
        <a href="/cota" className="text-ink/60 text-sm">
          {t.back}
        </a>
        <h1 className="text-ink text-xl font-semibold">{t.title}</h1>
        <p className="text-ink/70 text-sm">{t.lead}</p>
        <SignInPrompt label={lang === "es" ? "Inicia sesión" : "Sign in"} />
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 py-6">
      <a href="/cota" className="text-ink/60 text-sm">
        {t.back}
      </a>
      <h1 className="text-ink text-xl font-semibold">{t.title}</h1>
      <p className="text-ink/70 text-sm">{t.lead}</p>

      {error === "unconfigured" ? (
        <Note>{t.unconfigured}</Note>
      ) : (
        <>
          {error === "upstream" ? <Note>{t.upstream}</Note> : null}

          {address == null ? (
            <Button onClick={issue} disabled={busy}>
              {busy ? t.working : t.get}
            </Button>
          ) : (
            <Panel>
              <p className="text-ink/60 text-xs uppercase">{t.yours}</p>
              <p className="text-ink mt-1 font-mono text-sm break-all">
                {address}
              </p>
              <Button onClick={copy} className="mt-3">
                {copied ? t.copied : t.copy}
              </Button>
              <p className="text-ink/60 mt-3 text-xs">{t.permanent}</p>
              {state?.recipient ? (
                <p className="text-ink/60 mt-2 text-xs break-all">
                  {t.lands} <span className="font-mono">{state.recipient}</span>
                </p>
              ) : null}
            </Panel>
          )}

          <Note>{t.notAusd}</Note>
          <a
            href="/cota/swap"
            className="border-hull-line text-ink flex min-h-12 w-full items-center justify-center rounded-2xl border px-5 text-sm font-medium"
          >
            {t.swap}
          </a>
        </>
      )}
    </main>
  );
}
