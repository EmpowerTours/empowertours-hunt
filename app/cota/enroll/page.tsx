"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import type { Hex, TypedDataDefinition } from "viem";
import { useAuthSlot } from "@/app/providers";
import { Button, Note, Panel, Pill } from "@/components/ui/primitives";
import { LanguageSwitch } from "@/components/hunt/LanguageSwitch";
import { signInAccount } from "@/lib/auth/passkey";
import {
  buildTerms,
  clearEnrollment,
  DEFAULT_BUILDER_FEE_PER_100K,
  generateApiKeypair,
  isLive,
  loadEnrollment,
  proofOfPossession,
  saveEnrollment,
  toPayloadRequest,
  verifyPayloadMatchesTerms,
  type EnrolledKey,
  type EnrollTerms,
  type PerpPayload,
} from "@/lib/cota/enroll";

// ---------------------------------------------------------------------------
// Authorising a Perpl trading key — verifier-only.
//
// The key is made on this device, signs its own proof here, and is stored only
// in this browser. Hunt proxies the two venue calls (to send our whitelisted
// origin) but keeps nothing. What the user is agreeing to is shown as a sentence
// — Perpl's own `statement` — before the one Face ID prompt, because this is the
// signature that lets software trade for them later.
// ---------------------------------------------------------------------------

type Phase =
  | "loading"
  | "enrolled"
  | "signin"
  | "ready"
  | "review"
  | "busy"
  | "done"
  | "error";

interface Flight {
  secretHex: string;
  terms: EnrollTerms;
  payload: PerpPayload;
  mac: string;
  origin: string;
}

const FEE_BPS = DEFAULT_BUILDER_FEE_PER_100K / 10; // 20 per_100k -> 2 bps

const T = {
  es: {
    title: "Autoriza tu clave",
    intro:
      "Esto crea una clave de trading para Perpl que puede abrir y cerrar posiciones dentro de tu Cota. Por tu seguridad, la clave nunca puede sacar dinero de tu cuenta — sólo TÚ puedes retirar, desde tu propia wallet. Se guarda de forma segura para que el agente Cota opere dentro de tu correa; sigue sin poder retirar.",
    signin: "Inicia sesión para autorizar",
    begin: "Crear clave",
    fetching: "Preparando…",
    signingMsg: "Firma con Face ID…",
    submitting: "Registrando…",
    reviewTitle: "Vas a firmar esto",
    feeLabel: "Comisión máx.",
    scopeLabel: "Permisos",
    scopeVal: "abrir y cerrar · nunca retirar",
    expiresLabel: "Vence",
    confirm: "Confirmar y firmar",
    cancel: "Cancelar",
    doneTitle: "Clave autorizada ✓",
    doneBody:
      "Tu clave está guardada en este teléfono. Puede operar dentro de tu Cota pero nunca puede retirar tu dinero — sólo tú puedes, desde tu wallet. Vence en 90 días.",
    haveKey: "Ya tienes una clave activa",
    account: "Cuenta",
    reenrol: "Crear una nueva",
    retry: "Intentar de nuevo",
    deviceNote:
      "La clave vive sólo en este navegador. Si lo borras, autorízala de nuevo.",
    notConfigured: "La autorización no está habilitada en este momento.",
  },
  en: {
    title: "Authorize your key",
    intro:
      "This creates a Perpl trading key that can open and close positions within your Cota. For your safety the key can never move money out of your account — only YOU can withdraw, from your own wallet. A copy is held securely so the Cota agent can trade within your leash; it still can never withdraw.",
    signin: "Sign in to authorize",
    begin: "Create key",
    fetching: "Preparing…",
    signingMsg: "Sign with Face ID…",
    submitting: "Registering…",
    reviewTitle: "You're about to sign this",
    feeLabel: "Max fee",
    scopeLabel: "Permissions",
    scopeVal: "open and close · never withdraw",
    expiresLabel: "Expires",
    confirm: "Confirm & sign",
    cancel: "Cancel",
    doneTitle: "Key authorized ✓",
    doneBody:
      "Your key is saved on this phone. It can trade within your Cota but can never withdraw your money — only you can, from your wallet. It expires in 90 days.",
    haveKey: "You already have an active key",
    account: "Account",
    reenrol: "Create a new one",
    retry: "Try again",
    deviceNote:
      "The key lives only in this browser. Clear it and you'll authorize again.",
    notConfigured: "Authorization isn't enabled right now.",
  },
} as const;

function fmtDate(ms: number, locale: string): string {
  try {
    return new Date(ms).toLocaleDateString(
      locale === "es" ? "es-MX" : "en-US",
      {
        year: "numeric",
        month: "short",
        day: "numeric",
      },
    );
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

export default function CotaEnrollPage() {
  const auth = useAuthSlot();
  const locale = useLocale() === "es" ? "es" : "en";
  const t = T[locale];

  const [phase, setPhase] = useState<Phase>("loading");
  const [busyMsg, setBusyMsg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState<EnrolledKey | null>(null);
  const [statement, setStatement] = useState<string>("");
  const [reviewExpiresAt, setReviewExpiresAt] = useState<number | null>(null);

  // In-flight secrets live in a ref, out of render state.
  const flight = useRef<Flight | null>(null);

  // On mount: if this device already holds a live key, show it. Otherwise the
  // phase depends on whether the wallet is available yet.
  useEffect(() => {
    let ignore = false;
    // Async closure so the state updates land in a microtask rather than
    // synchronously in the effect body — same pattern as the dime/practice
    // screens. localStorage is client-only, so this must run in an effect.
    void (async () => {
      const existing = loadEnrollment();
      if (ignore) return;
      if (isLive(existing)) {
        setKey(existing);
        setPhase("enrolled");
      } else {
        setPhase(auth.status === "signed-in" ? "ready" : "signin");
      }
    })();
    return () => {
      ignore = true;
    };
  }, [auth.status]);

  const fail = useCallback((message: string) => {
    flight.current = null;
    setError(message);
    setPhase("error");
  }, []);

  // Step 1: make a key, ask the venue for the payload, and verify it names
  // exactly what we asked for — before any wallet prompt.
  const begin = useCallback(async () => {
    setError(null);
    const address = auth.walletAddress;
    if (!address) {
      setPhase("signin");
      return;
    }
    setPhase("busy");
    setBusyMsg(t.fetching);
    try {
      const { secretHex, publicKeyHex } = generateApiKeypair();
      const terms = buildTerms({
        address,
        publicKeyHex,
        label: `cota-${Date.now()}`,
      });
      const res = await fetch("/api/cota/enroll/payload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toPayloadRequest(terms)),
      });
      const body = (await res.json()) as {
        typed_data?: PerpPayload;
        mac?: string;
        origin?: string;
        error?: string;
        detail?: string;
      };
      if (!res.ok || !body.typed_data || !body.mac || !body.origin) {
        // Show the venue's own words too — the reason ("origin not whitelisted",
        // "profile not found") is what tells us how to fix it.
        fail(
          [body.error ?? t.notConfigured, body.detail]
            .filter(Boolean)
            .join(" — "),
        );
        return;
      }
      // The check that protects the user from signing the wrong thing.
      verifyPayloadMatchesTerms(body.typed_data, terms, body.origin);

      flight.current = {
        secretHex,
        terms,
        payload: body.typed_data,
        mac: body.mac,
        origin: body.origin,
      };
      setStatement(String(body.typed_data.message.statement ?? ""));
      setReviewExpiresAt(terms.expiresAt);
      setPhase("review");
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }, [auth.walletAddress, t, fail]);

  // Step 2: one Face ID signature over the payload, an Ed25519 proof over the
  // same digest, then submit both and save the credential on the device.
  const confirm = useCallback(async () => {
    const f = flight.current;
    if (!f) {
      fail("nothing to sign");
      return;
    }
    // Clear the ref up front — we hold everything in the local `f` through the
    // awaits, and the secret should not linger in the ref while we sign.
    flight.current = null;
    setError(null);
    setPhase("busy");
    setBusyMsg(t.signingMsg);
    try {
      let signature: Hex;
      const passkey = await signInAccount();
      try {
        signature = await passkey.account.signTypedData(
          f.payload as unknown as TypedDataDefinition,
        );
      } finally {
        passkey.session.end();
      }

      setBusyMsg(t.submitting);
      const popSignature = proofOfPossession(f.payload, f.secretHex);
      const res = await fetch("/api/cota/enroll/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chain_id: f.terms.chainId,
          address: f.terms.address,
          typed_data: f.payload,
          mac: f.mac,
          signature,
          pop_signature: popSignature,
        }),
      });
      const body = (await res.json()) as {
        api_key?: Record<string, unknown>;
        error?: string;
        detail?: string;
      };
      if (!res.ok) {
        // Perpl's status+detail is in body.error (e.g. "…(404)") and body.detail;
        // surface both so the exact refusal reason is visible on-device.
        fail([body.error ?? t.retry, body.detail].filter(Boolean).join(" — "));
        return;
      }
      const info = (body.api_key ?? body) as Record<string, unknown>;
      const token = info.api_key as string | undefined;
      if (!token) {
        fail("the venue returned no key");
        return;
      }

      const enrolled: EnrolledKey = {
        apiKey: token,
        secretHex: f.secretHex,
        account: f.terms.address,
        builderId: info.builder_id as number | undefined,
        builderName: info.builder_name as string | undefined,
        maxBuilderFeePer100k:
          (info.max_builder_fee_per_100k as number | undefined) ??
          f.terms.maxBuilderFeePer100k,
        scopeMask: (info.scope_mask as number | undefined) ?? f.terms.scopeMask,
        origin: (info.origin as string | undefined) ?? f.origin,
        expiresAt:
          Number(info.expires_at ?? f.terms.expiresAt) || f.terms.expiresAt,
      };
      saveEnrollment(enrolled);
      // Hand the key to the server so the Cota agent can trade within your
      // leash. Best-effort: the enrollment has succeeded and the key is on the
      // device regardless; a failed delivery just means the agent can't act yet
      // (retryable). The key can only trade, never withdraw.
      try {
        await fetch("/api/cota/perp-key", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            apiKey: enrolled.apiKey,
            secretHex: enrolled.secretHex,
            account: enrolled.account,
          }),
        });
      } catch {
        // Non-fatal; the hunter still holds the key on this device.
      }
      setKey(enrolled);
      setPhase("done");
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }, [t, fail]);

  const reenrol = useCallback(() => {
    clearEnrollment();
    setKey(null);
    flight.current = null;
    setPhase(auth.status === "signed-in" ? "ready" : "signin");
  }, [auth.status]);

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-5 px-5 py-8">
      <header className="flex items-center justify-between">
        <h1 className="text-ink text-2xl font-black tracking-tight">
          {t.title}
        </h1>
        <LanguageSwitch />
      </header>

      {phase === "loading" ? (
        <p className="text-ink-dim text-sm">…</p>
      ) : phase === "enrolled" && key ? (
        <Panel>
          <div className="flex flex-col gap-3">
            <Pill color="#4ade80">{t.haveKey}</Pill>
            <dl className="text-sm">
              <div className="flex justify-between py-1">
                <dt className="text-ink-dim">{t.account}</dt>
                <dd className="font-mono text-xs">
                  {key.account.slice(0, 6)}…{key.account.slice(-4)}
                </dd>
              </div>
              <div className="flex justify-between py-1">
                <dt className="text-ink-dim">{t.expiresLabel}</dt>
                <dd>{fmtDate(key.expiresAt, locale)}</dd>
              </div>
              <div className="flex justify-between py-1">
                <dt className="text-ink-dim">{t.scopeLabel}</dt>
                <dd>{t.scopeVal}</dd>
              </div>
            </dl>
            <Button tone="ghost" onClick={reenrol}>
              {t.reenrol}
            </Button>
          </div>
        </Panel>
      ) : phase === "signin" ? (
        <div className="flex flex-col gap-4">
          <p className="text-ink-dim text-sm">{t.intro}</p>
          <Button onClick={() => void auth.signIn()}>{t.signin}</Button>
        </div>
      ) : phase === "ready" ? (
        <div className="flex flex-col gap-4">
          <p className="text-ink-dim text-sm">{t.intro}</p>
          <Note tone="info">{t.deviceNote}</Note>
          <Button onClick={() => void begin()}>{t.begin}</Button>
        </div>
      ) : phase === "review" ? (
        <div className="flex flex-col gap-4">
          <Note tone="warn" title={t.reviewTitle}>
            {statement}
          </Note>
          <Panel>
            <dl className="text-sm">
              <div className="flex justify-between py-1">
                <dt className="text-ink-dim">{t.feeLabel}</dt>
                <dd>{FEE_BPS} bps</dd>
              </div>
              <div className="flex justify-between py-1">
                <dt className="text-ink-dim">{t.scopeLabel}</dt>
                <dd>{t.scopeVal}</dd>
              </div>
              <div className="flex justify-between py-1">
                <dt className="text-ink-dim">{t.expiresLabel}</dt>
                <dd>
                  {reviewExpiresAt ? fmtDate(reviewExpiresAt, locale) : ""}
                </dd>
              </div>
            </dl>
          </Panel>
          <Button onClick={() => void confirm()}>{t.confirm}</Button>
          <Button tone="ghost" onClick={reenrol}>
            {t.cancel}
          </Button>
        </div>
      ) : phase === "busy" ? (
        <p className="text-ink-dim py-8 text-center text-sm">{busyMsg}</p>
      ) : phase === "done" && key ? (
        <div className="flex flex-col gap-3">
          <div className="text-xl font-bold text-[#4ade80]">{t.doneTitle}</div>
          <p className="text-ink-dim text-sm">{t.doneBody}</p>
        </div>
      ) : phase === "error" ? (
        <div className="flex flex-col gap-4">
          <Note tone="stop" title="Error">
            {error}
          </Note>
          <Button onClick={() => void begin()}>{t.retry}</Button>
        </div>
      ) : null}
    </main>
  );
}
