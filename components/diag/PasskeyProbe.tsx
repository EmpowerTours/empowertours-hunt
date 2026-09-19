"use client";

import { useEffect, useState } from "react";
import { Button, Note, Panel } from "@/components/ui/primitives";
import { RP_ID } from "@/lib/auth/passkey";
import {
  getPrfViaNative,
  nativeAppInfo,
  nativePasskeyAvailable,
  type NativeAppInfo,
} from "@/lib/auth/native-passkey";

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

/**
 * What each probe PROVED, as opposed to what it printed.
 *
 * "timeout" and "error" are kept apart on purpose. A sheet that opens and never
 * resolves and a provider that answers with a failure look equally red on the
 * screen and mean different things — the first is nothing listening, the second
 * is something listening and unable to serve. The first version of this panel
 * collapsed both into "both lookups timed out", and then said exactly that
 * about a device which had in fact answered in three seconds. A diagnostic that
 * narrates a mechanism the evidence does not show is worse than none.
 */
type Fail = "timeout" | "error";

/**
 * The THIRD road, and the reason this section exists at all.
 *
 * The two buttons above both go through the WebView, which on some devices is
 * the broken path. Sign-in now falls back to Credential Manager natively when
 * that happens — and the diagnostic could not see it, so a screenshot of this
 * page said "everything fails" about a phone where sign-in might work. A probe
 * that cannot test the road being taken is measuring the wrong thing.
 */
type Verdicts = {
  /** The credential was found and the assertion completed. */
  plain?: "ok" | Fail;
  /** "noprf" = the assertion worked but the extension was not evaluated. */
  prf?: "ok" | "noprf" | Fail;
};

/** Our own guard, as opposed to anything the platform reports. */
const NO_ANSWER = "NoAnswer:";

/* ---------------------------------------------------------------------------
   The probe has to state its own conclusion.

   Two lines of raw output are only a measurement to someone who already knows
   what they mean, and the person running this is holding a phone in another
   city. Worse, the two failures look identical on screen and lead to entirely
   different projects — one is a device to swap, the other is a rewrite of how
   the ceremony runs.
--------------------------------------------------------------------------- */
function verdictOf(v: Verdicts): { title: string; body: string } | null {
  if (v.plain === undefined || v.prf === undefined) return null;

  const bothFailed = v.plain !== "ok" && v.prf !== "ok" && v.prf !== "noprf";

  if (bothFailed && v.plain === "timeout" && v.prf === "timeout") {
    return {
      title: "This device never answered",
      body: "Both lookups ran out the clock, with and without extensions — so this is not about what the request contained. The system credential sheet opened and nothing responded to it. Nothing in the app or on the website can fix that. Try the same app on a different Android phone: if sign-in works there, this device is the problem.",
    };
  }

  if (bothFailed) {
    return {
      title: "The credential manager refused",
      body: "Both lookups failed the same way, with and without extensions, so this is not about what the request contained — and they failed quickly rather than hanging, which means the provider IS answering and cannot serve the credential. That is usually Google Play services or Google Password Manager on this device, not the app: update both from the Play Store, confirm the phone is signed in to the Google account holding the passkey, and check Google Password Manager is enabled as a credential provider. This app signs in on other Android phones.",
    };
  }
  if (v.plain === "ok" && v.prf !== "ok") {
    return {
      title: "Found the passkey, cannot derive the wallet",
      body: "The lookup succeeded without PRF and failed with it. The credential is reachable here, but this WebView will not evaluate the PRF extension — and PRF is what the wallet is made of. No configuration fixes this; the ceremony has to run outside the WebView.",
    };
  }
  if (v.plain === "ok" && v.prf === "ok") {
    return {
      title: "Everything the wallet needs works here",
      body: "Both lookups completed and PRF was evaluated. If sign-in still fails on this device, the fault is after the ceremony — the error text on the sign-in screen is the next clue, not this probe.",
    };
  }
  return {
    title: "Mixed result",
    body: "The plain lookup failed while the PRF one did not, which is backwards and usually means one of the two was answered by a different provider, or cancelled by hand. Run both again without touching the sheet.",
  };
}

function describe(e: unknown): string {
  if (e instanceof Error) {
    const name = e.name && e.name !== "Error" ? `${e.name}: ` : "";
    return `${name}${e.message}`;
  }
  return String(e);
}

export function PasskeyProbe() {
  const [busy, setBusy] = useState<null | "plain" | "prf" | "native">(null);
  const [nativeReady, setNativeReady] = useState(false);
  const [appInfo, setAppInfo] = useState<NativeAppInfo | null>(null);

  // Asks the plugin, so an older APK without it reports false rather than
  // offering a button that rejects with "not implemented".
  useEffect(() => {
    void nativePasskeyAvailable()
      .then(setNativeReady)
      .catch(() => setNativeReady(false));
    void nativeAppInfo()
      .then(setAppInfo)
      .catch(() => setAppInfo(null));
  }, []);
  const [elapsed, setElapsed] = useState(0);
  const [results, setResults] = useState<Outcome[]>([]);
  const [verdicts, setVerdicts] = useState<Verdicts>({});
  const [nativeOk, setNativeOk] = useState<boolean | null>(null);

  const runNative = async () => {
    setBusy("native");
    setElapsed(0);
    const started = Date.now();
    const tick = setInterval(
      () => setElapsed(Math.round((Date.now() - started) / 1000)),
      1000,
    );
    try {
      // PROBE_SALT again, not the wallet's: this answers whether the road is
      // open, and no diagnostic should derive real key material to do it.
      const { prfOutput, credentialId } = await getPrfViaNative({
        rpId: RP_ID,
        prfSalt: PROBE_SALT,
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const secs = Math.round((Date.now() - started) / 1000);
      setResults((r) => [
        ...r,
        {
          label: "via credential manager",
          text: `OK in ${secs}s, credential ${credentialId.slice(0, 12)}…, PRF ${prfOutput.length} bytes`,
          tone: "ok",
        },
      ]);
      setNativeOk(true);
    } catch (e: unknown) {
      setResults((r) => [
        ...r,
        {
          label: "via credential manager",
          text: `${describe(e)} (after ${Math.round((Date.now() - started) / 1000)}s)`,
          tone: "bad",
        },
      ]);
      setNativeOk(false);
    } finally {
      clearInterval(tick);
      setBusy(null);
    }
  };

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
        () => reject(new Error(`${NO_ANSWER} the sheet never resolved`)),
        PROBE_TIMEOUT_MS + 5_000,
      ),
    );

    try {
      const cred = (await Promise.race([
        navigator.credentials.get({ publicKey: options }),
        guard,
      ])) as PublicKeyCredential | null;

      if (cred === null) {
        setVerdicts((v) => ({ ...v, [kind]: "error" }));
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

      setVerdicts((v) => ({
        ...v,
        [kind]: kind === "prf" ? (gotPrf ? "ok" : "noprf") : "ok",
      }));

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
      const timedOut = e instanceof Error && e.message.startsWith(NO_ANSWER);
      setVerdicts((v) => ({ ...v, [kind]: timedOut ? "timeout" : "error" }));
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
        {nativeReady ? (
          <Button
            type="button"
            tone="ghost"
            disabled={busy !== null}
            onClick={() => void runNative()}
          >
            {busy === "native" ? `${elapsed}s…` : "Credential Manager"}
          </Button>
        ) : null}
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

      {appInfo !== null ? (
        <dl className="space-y-2">
          <div>
            <dt className="text-ink-faint font-mono text-[11px] tracking-[0.16em] uppercase">
              installed build
            </dt>
            <dd className="text-ink-dim mt-0.5 font-mono text-xs break-all">
              {appInfo.versionName ?? "?"} ({appInfo.versionCode ?? "?"})
            </dd>
          </div>
          <div>
            <dt className="text-ink-faint font-mono text-[11px] tracking-[0.16em] uppercase">
              asset statements declared
            </dt>
            {/* The distinction "RP ID cannot be validated" cannot make by
                itself: is the declaration missing from this APK, or present and
                being refused? */}
            <dd
              className={`mt-0.5 font-mono text-xs break-all ${
                appInfo.hasAssetStatementsMetaData === true
                  ? "text-phosphor"
                  : "text-red-400"
              }`}
            >
              {appInfo.hasAssetStatementsMetaData === true
                ? (appInfo.assetStatements ?? "yes")
                : "NO — this APK predates the fix, reinstall from /download"}
            </dd>
          </div>
        </dl>
      ) : null}

      {nativeOk === true ? (
        <Note tone="warn" title="The native road works">
          Credential Manager served the passkey and evaluated PRF, even though
          the WebView path on this phone does not. Sign-in uses this road
          automatically when the first one fails, so tap sign in — and check the
          address matches the one your browser shows.
        </Note>
      ) : null}

      {(() => {
        const v = verdictOf(verdicts);
        return v === null ? null : (
          <Note tone="warn" title={v.title}>
            {v.body}
          </Note>
        );
      })()}

      {busy !== null ? (
        <Note tone="warn" title="Probing">
          If your phone shows a passkey sheet, answer it. If nothing appears,
          let it run — how it ends is the measurement.
        </Note>
      ) : null}
    </Panel>
  );
}
