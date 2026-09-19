"use client";

import { useState } from "react";
import { Button, Note, Panel } from "@/components/ui/primitives";
import { RP_ID } from "@/lib/auth/passkey";

/* ---------------------------------------------------------------------------
   The probe that separates "no passkey here" from "PRF is the thing failing".

   Everything else on /diag is passive — it reads capabilities without opening a
   ceremony, deliberately, so the diagnostic cannot become the failure. This one
   is different and is therefore a BUTTON: nothing runs until someone taps it.

   It exists because of a measurement we could not otherwise make. On the vivo,
   the app's sign-in opens the system sheet and the sheet spins forever, while
   Chrome on that same phone holds a working passkey. Asset links are verified
   good — Google's own statements:list resolves our package and fingerprint — and
   the sheet opening proves the WebView dispatched the request. What is left is
   what the request CONTAINS, and the app path differs from Chrome in exactly one
   interesting way: WEB_AUTHENTICATION_SUPPORT_FOR_APP routes through the Play
   services FIDO2 path, and our assertion carries the PRF extension, because PRF
   IS the wallet.

   So: run the same assertion twice, once with PRF and once without, and see
   which one hangs. Two outcomes, two different projects:

     plain OK + prf hangs  -> the credential is reachable and the app path will
                              not evaluate PRF. The wallet cannot be derived in
                              this WebView and no amount of asset-links work
                              changes it.
     both hang             -> the provider is not answering at all. A device
                              problem (Play services, credential provider), not
                              a PRF one.

   SAFETY: the PRF probe evaluates a DIFFERENT salt from the wallet's. It must
   never derive real key material into a diagnostic page — the point is whether
   the extension is honoured, which any salt answers. It is also get() only, so
   nothing here can create a credential or hand anyone a second wallet.
--------------------------------------------------------------------------- */

/** Not HUNT_PRF_SALT. Deliberately unrelated to any key this app derives. */
const PROBE_SALT = new TextEncoder().encode(
  "empowertours.diag.probe.v1.not-a-wallet",
);

/** Short on purpose: this is a test, not a sign-in. A hang should read as a hang. */
const PROBE_TIMEOUT_MS = 20_000;

type Outcome = {
  label: string;
  text: string;
  tone: "ok" | "bad";
};

function describe(e: unknown): string {
  if (e instanceof Error) {
    const name = e.name && e.name !== "Error" ? `${e.name}: ` : "";
    return `${name}${e.message}`;
  }
  return String(e);
}

export function PasskeyProbe() {
  const [busy, setBusy] = useState<null | "plain" | "prf">(null);
  const [elapsed, setElapsed] = useState(0);
  const [results, setResults] = useState<Outcome[]>([]);

  const run = async (kind: "plain" | "prf") => {
    setBusy(kind);
    setElapsed(0);
    const started = Date.now();
    const tick = setInterval(
      () => setElapsed(Math.round((Date.now() - started) / 1000)),
      1000,
    );

    const challenge = new Uint8Array(32);
    crypto.getRandomValues(challenge);

    const options: PublicKeyCredentialRequestOptions = {
      challenge,
      rpId: RP_ID,
      // Empty: a discoverable lookup, which is what the app does when this
      // origin's storage holds nothing — the exact case being diagnosed.
      allowCredentials: [],
      userVerification: "required",
      timeout: PROBE_TIMEOUT_MS,
      ...(kind === "prf"
        ? {
            extensions: {
              prf: { eval: { first: PROBE_SALT } },
            } as AuthenticationExtensionsClientInputs,
          }
        : {}),
    };

    // The platform's own timeout is advisory and the sheet has been observed
    // outliving it, so the page keeps its own clock. Without this the probe
    // would hang exactly like the thing it is measuring.
    const guard = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("NoAnswer: the sheet never resolved")),
        PROBE_TIMEOUT_MS + 5_000,
      ),
    );

    try {
      const cred = (await Promise.race([
        navigator.credentials.get({ publicKey: options }),
        guard,
      ])) as PublicKeyCredential | null;

      if (cred === null) {
        setResults((r) => [
          ...r,
          {
            label: kind === "prf" ? "with PRF" : "without PRF",
            text: "returned null — no credential, no error",
            tone: "bad",
          },
        ]);
        return;
      }

      const ext = cred.getClientExtensionResults() as {
        prf?: { results?: { first?: ArrayBuffer } };
      };
      const gotPrf = ext.prf?.results?.first !== undefined;
      const secs = Math.round((Date.now() - started) / 1000);

      setResults((r) => [
        ...r,
        {
          label: kind === "prf" ? "with PRF" : "without PRF",
          text:
            kind === "prf"
              ? `OK in ${secs}s, credential ${cred.id.slice(0, 12)}…, PRF evaluated: ${gotPrf ? "YES" : "NO"}`
              : `OK in ${secs}s, credential ${cred.id.slice(0, 12)}…`,
          // A PRF probe that succeeds WITHOUT evaluating prf is the bad case:
          // the ceremony worked and the extension was silently dropped, which
          // is precisely how a wallet goes missing rather than erroring.
          tone: kind === "prf" && !gotPrf ? "bad" : "ok",
        },
      ]);
    } catch (e: unknown) {
      setResults((r) => [
        ...r,
        {
          label: kind === "prf" ? "with PRF" : "without PRF",
          text: `${describe(e)} (after ${Math.round((Date.now() - started) / 1000)}s)`,
          tone: "bad",
        },
      ]);
    } finally {
      clearInterval(tick);
      setBusy(null);
    }
  };

  return (
    <Panel className="space-y-3">
      <div>
        <h2 className="text-ink text-sm font-semibold">Passkey probe</h2>
        <p className="text-ink-dim mt-1 text-xs leading-snug">
          Runs the same lookup sign-in runs, once without the PRF extension and
          once with it. Nothing is created and no wallet key is derived — the
          PRF probe uses an unrelated salt. Tap both, then screenshot.
        </p>
      </div>

      <div className="flex gap-2">
        <Button
          type="button"
          tone="ghost"
          disabled={busy !== null}
          onClick={() => void run("plain")}
        >
          {busy === "plain" ? `${elapsed}s…` : "Without PRF"}
        </Button>
        <Button
          type="button"
          tone="ghost"
          disabled={busy !== null}
          onClick={() => void run("prf")}
        >
          {busy === "prf" ? `${elapsed}s…` : "With PRF"}
        </Button>
      </div>

      {results.length > 0 ? (
        <dl className="space-y-2">
          {results.map((r, i) => (
            <div key={`${r.label}-${i}`}>
              <dt className="text-ink-faint font-mono text-[11px] tracking-[0.16em] uppercase">
                {r.label}
              </dt>
              <dd
                className={`mt-0.5 font-mono text-xs break-all ${
                  r.tone === "bad" ? "text-red-400" : "text-phosphor"
                }`}
              >
                {r.text}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {busy !== null ? (
        <Note tone="warn" title="Probing">
          If your phone shows a passkey sheet, answer it. If nothing appears,
          let it run — how it ends is the measurement.
        </Note>
      ) : null}
    </Panel>
  );
}
