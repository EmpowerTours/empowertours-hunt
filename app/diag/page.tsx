"use client";

import { useEffect, useState } from "react";
import { Note, Panel } from "@/components/ui/primitives";
import { RP_ID, storedCredential } from "@/lib/auth/passkey";
import { HUNT_PRF_SALT_LABEL } from "@/lib/auth/derive";
import { PasskeyProbe } from "@/components/diag/PasskeyProbe";

// ---------------------------------------------------------------------------
// One screen that answers "why can't this device sign in".
//
// Sign-in fails inside the Android app and the phone is three hours away, which
// is the ordinary case for a bug report: the person who can reproduce it is not
// the person who can read a stack trace, and neither of them has a USB cable to
// hand. adb logcat is the right tool and it is unavailable exactly when it is
// needed.
//
// So the checks run in the page and print their own answers. Every line is
// something measured here and now — no capability is inferred from the user
// agent, because a WebView's user agent is a claim and `isConditionalMediation
// Available()` is a measurement.
//
// It deliberately renders BEFORE asking for anything. Opening a passkey prompt
// to find out whether passkeys work would make the diagnostic and the failure
// the same event.
// ---------------------------------------------------------------------------

interface Check {
  label: string;
  value: string;
  /** ok = works, bad = this is the failure, info = context, not a verdict. */
  tone: "ok" | "bad" | "info";
  why?: string;
}

export default function DiagnosticsPage() {
  const [checks, setChecks] = useState<Check[] | null>(null);

  useEffect(() => {
    void (async () => {
      const out: Check[] = [];
      const yes = (b: boolean) => (b ? "yes" : "no");

      // --- The three that decide whether a passkey is even possible --------
      const secure = window.isSecureContext;
      out.push({
        label: "Secure context (https)",
        value: yes(secure),
        tone: secure ? "ok" : "bad",
        why: secure
          ? undefined
          : "WebAuthn and WebCrypto both refuse outside a secure context. In the app this means the WebView is not on https — a configuration fault, not a device limit.",
      });

      const hasPk = typeof window.PublicKeyCredential !== "undefined";
      out.push({
        label: "WebAuthn available",
        value: yes(hasPk),
        tone: hasPk ? "ok" : "bad",
        why: hasPk
          ? undefined
          : "This WebView cannot do passkeys at all. On Android that is the system WebView being too old — update Android System WebView in the Play Store. No change to this app can work around it.",
      });

      let platform = false;
      if (hasPk) {
        try {
          platform =
            await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
        } catch {
          platform = false;
        }
      }
      out.push({
        label: "Phone can hold a passkey",
        value: yes(platform),
        tone: platform ? "ok" : "bad",
        why: platform
          ? undefined
          : "No screen lock, or no passkey provider. On Android: set a screen lock and sign in to Google Password Manager.",
      });

      // --- Origin and relying party ---------------------------------------
      // The commonest silent failure is a page whose host is not a registrable
      // subdomain of the relying-party id. It produces a SecurityError that
      // reads like a device problem and is not one.
      const host = window.location.hostname.toLowerCase();
      const rp = RP_ID.toLowerCase();
      const rpOk = host === rp || host.endsWith("." + rp);
      out.push({
        label: "Page host",
        value: window.location.origin,
        tone: "info",
      });
      out.push({
        label: "Relying party (rpId)",
        value: rp,
        tone: rpOk ? "ok" : "bad",
        why: rpOk
          ? undefined
          : `This page is served from ${host}, which is not ${rp} nor a subdomain of it. WebAuthn refuses that with a SecurityError.`,
      });

      // --- Is this the app or a browser? ----------------------------------
      // Worth stating plainly and first, because "it works in Chrome" and "it
      // works in the app" are different claims and the whole question is which
      // one is failing. The first screenshot of this page came from Chrome and
      // said nothing about the app, which is how this line earned its place at
      // the top rather than buried among the context rows.
      const ua = navigator.userAgent;
      const marked = / EmpowerToursApp\/1 /.test(ua);
      const inApp =
        marked ||
        typeof (window as { Capacitor?: unknown }).Capacitor !== "undefined";
      out.push({
        label: "Running inside the app",
        value: inApp ? "yes (app WebView)" : "no — this is an ordinary browser",
        tone: inApp ? "info" : "bad",
        why: inApp
          ? undefined
          : "This measures the browser you opened it in, not the app. To diagnose the app, open the EmpowerTours app and go to /diag from inside it.",
      });

      // What the NATIVE side decided, reported through a user-agent marker.
      //
      // window.PublicKeyCredential exists in a WebView whether or not
      // setWebAuthenticationSupport was ever called, so the JS-visible surface
      // cannot tell "configured" from "not". This can: MainActivity writes the
      // verdict into the user agent before the first load.
      if (marked) {
        const enabled = / WebAuthnSupport\/1\b/.test(ua);
        out.push({
          label: "WebAuthn enabled by the app",
          value: enabled ? "yes" : "no",
          tone: enabled ? "ok" : "bad",
          why: enabled
            ? undefined
            : "This device's system WebView cannot do WebAuthn, so the app cannot run a passkey ceremony at all. Update Android System WebView from the Play Store, then reopen the app. Nothing in this app can work around it.",
        });
      }

      // --- Does this device already know one of our credentials? -----------
      const known = storedCredential();
      out.push({
        label: "Passkey remembered here",
        value:
          known === undefined ? "none" : known.credentialId.slice(0, 12) + "…",
        tone: "info",
        why:
          known === undefined
            ? "Nothing stored on this device. A first sign-in will find nothing and offer to make a new wallet — that is expected, not a fault."
            : undefined,
      });

      out.push({ label: "PRF salt", value: HUNT_PRF_SALT_LABEL, tone: "info" });
      out.push({
        label: "User agent",
        value: navigator.userAgent,
        tone: "info",
      });

      setChecks(out);
    })();
  }, []);

  const blocking = checks?.filter((c) => c.tone === "bad") ?? [];

  return (
    <main className="safe-top safe-bottom mx-auto flex w-full max-w-md flex-col gap-4 px-5 py-8">
      {/* The app has no address bar, so a page reached from a link needs a way
          out of it. Without this, /diag is a dead end inside the WebView. */}
      <a href="/cota" className="text-ink-dim w-fit text-sm hover:underline">
        ← Cota
      </a>

      <header>
        <h1 className="text-ink text-2xl font-bold tracking-tight">
          Sign-in diagnostics
        </h1>
        <p className="text-ink-dim mt-2 text-sm leading-snug">
          Everything below is measured on this device, right now. Screenshot
          this page — it says why sign-in fails without needing a cable.
        </p>
      </header>

      {checks === null ? (
        <Panel>
          <p className="text-ink-dim font-mono text-sm">Checking…</p>
        </Panel>
      ) : (
        <>
          {blocking.length === 0 ? (
            <Note title="Nothing here blocks a passkey">
              This device can run the ceremony. If sign-in still fails, the
              failure is in the ceremony itself rather than in what the device
              supports — the error text on the sign-in screen is the next clue.
            </Note>
          ) : (
            <Note
              tone="stop"
              title={`${blocking.length} blocking problem${blocking.length > 1 ? "s" : ""}`}
            >
              {blocking.map((c) => c.why ?? c.label).join(" ")}
            </Note>
          )}

          <Panel>
            <dl className="space-y-3">
              {checks.map((c) => (
                <div key={c.label}>
                  <dt className="text-ink-faint font-mono text-[11px] tracking-[0.16em] uppercase">
                    {c.label}
                  </dt>
                  <dd
                    className={`mt-0.5 font-mono text-sm break-all ${
                      c.tone === "bad"
                        ? "text-red-400"
                        : c.tone === "ok"
                          ? "text-phosphor"
                          : "text-ink-dim"
                    }`}
                  >
                    {c.value}
                  </dd>
                  {c.tone === "bad" && c.why ? (
                    <p className="text-ink-dim mt-1 text-xs leading-snug">
                      {c.why}
                    </p>
                  ) : null}
                </div>
              ))}
            </dl>
          </Panel>

          <PasskeyProbe />
        </>
      )}
    </main>
  );
}
