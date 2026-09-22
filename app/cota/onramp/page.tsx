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

interface Deposit {
  status: string;
  txHash: string | null;
  chain: string | null;
  amountFormatted: string | null;
  createdAt: string | null;
}

interface AddressState {
  address: string | null;
  depositChain: string;
  recipient?: string;
  deposits?: Deposit[];
}

const COPY = {
  es: {
    title: "Fondear desde cualquier red",
    lead: "Te damos una dirección. Envía desde otra red EVM, un exchange o tu wallet — llega como USDC en Monad.",
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
    arrivals: "Lo que ha llegado",
    nothingYet:
      "Nada todavía. Cuando envíes, aparece aquí — primero salida, luego llegada.",
    left: "salió de",
    arrived: "llegó a Monad",
    refresh: "Actualizar",
    canSend: "Qué puedes enviar",
    onlyThese:
      "SOLO estos activos, y solo desde estas redes. Aurora no devuelve lo que no reconoce — un envío fuera de esta lista puede perderse y no hay forma de recuperarlo.",
    listDown:
      "No podemos leer la lista ahora mismo. No envíes nada hasta que cargue.",
    more: "y",
  },
  en: {
    title: "Fund from any chain",
    lead: "We give you an address. Send from another EVM chain, an exchange or your wallet — it arrives as USDC on Monad.",
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
    arrivals: "What has arrived",
    nothingYet:
      "Nothing yet. Once you send, it shows here — first the departure, then the arrival.",
    left: "left",
    arrived: "arrived on Monad",
    refresh: "Refresh",
    canSend: "What you can send",
    onlyThese:
      "ONLY these assets, and only from these chains. Aurora does not return what it does not recognise — a send outside this list can be lost with no way to recover it.",
    listDown:
      "We cannot read the list right now. Do not send anything until it loads.",
    more: "and",
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
  const [options, setOptions] = useState<
    Array<{ chain: string; symbols: string[] }> | null
  >(null);

  // A GET never calls Aurora — it only reads what we already issued — so this
  // is safe to run on open and tells us both the address and whether the route
  // is configured at all.
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/cota/aurora?type=all", {
          cache: "no-store",
        });
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

  // Public and unauthenticated on purpose — this is the one thing on the page
  // that must render even when the session or the key is not working, because
  // it is what stops a hunter sending an asset that cannot come back.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/cota/aurora/tokens", {
          cache: "no-store",
        });
        if (!live || !res.ok) return;
        const body = (await res.json()) as {
          options?: Array<{ chain: string; symbols: string[] }>;
        };
        setOptions(body.options ?? []);
      } catch {
        // Left null, which the screen renders as "do not send yet".
      }
    })();
    return () => {
      live = false;
    };
  }, []);

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

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/cota/aurora?type=all", {
        cache: "no-store",
      });
      if (res.ok) setState((await res.json()) as AddressState);
    } catch {
      // A failed refresh leaves the last known list on screen rather than
      // blanking it: an empty list here reads as "nothing arrived", and that is
      // a claim a network error has no business making.
    }
  }, []);

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

          {address == null ? null : (
            <Panel>
              <div className="flex items-center justify-between gap-2">
                <p className="text-ink/60 text-xs uppercase">{t.arrivals}</p>
                <button
                  type="button"
                  onClick={refresh}
                  className="text-ink/60 text-xs underline"
                >
                  {t.refresh}
                </button>
              </div>
              {(state?.deposits?.length ?? 0) === 0 ? (
                <p className="text-ink/60 mt-2 text-xs">{t.nothingYet}</p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {state!.deposits!.map((d, i) => (
                    <li
                      key={`${d.txHash ?? "row"}-${i}`}
                      className="text-ink text-sm"
                    >
                      <span className="font-mono">
                        {d.amountFormatted ?? "?"}
                      </span>{" "}
                      USDC{" "}
                      <span className="text-ink/60">
                        {d.status === "SUCCESS"
                          ? t.arrived
                          : `${t.left} ${d.chain ?? "?"}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}

          <Panel>
            <p className="text-ink/60 text-xs uppercase">{t.canSend}</p>
            {options === null ? (
              <p className="text-ink mt-2 text-xs">{t.listDown}</p>
            ) : (
              <>
                <ul className="mt-2 space-y-1">
                  {options.map((o) => (
                    <li key={o.chain} className="text-ink text-sm">
                      <span className="font-mono uppercase">{o.chain}</span>{" "}
                      <span className="text-ink/70">
                        {/* Hiding exactly one reads as a bug — "USDT0 y 1" —
                            so the cut only happens when it saves something. */}
                        {o.symbols.length <= 7
                          ? o.symbols.join(", ")
                          : `${o.symbols.slice(0, 6).join(", ")} ${t.more} ${o.symbols.length - 6}`}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-ink/60 mt-3 text-xs">{t.onlyThese}</p>
              </>
            )}
          </Panel>

          <Note>{t.notAusd}</Note>
          <a
            href="/cota/swap/usdc"
            className="border-hull-line text-ink flex min-h-12 w-full items-center justify-center rounded-2xl border px-5 text-sm font-medium"
          >
            {t.swap}
          </a>
        </>
      )}
    </main>
  );
}
