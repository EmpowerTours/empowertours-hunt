"use client";

// Passkey diagnostic probe. Not part of the product — a controlled experiment
// to surface, on a device with no devtools, the EXACT native error a raw
// WebAuthn get() throws on this origin. Isolates raw WebAuthn from mera, PRF,
// and the app's sign-in flow, so we can see whether cross-subdomain get() is
// what fails and with what error.

import { useState } from "react";

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

export default function CotaDiagPage() {
  const [rpId, setRpId] = useState("empowertours.xyz");
  const [log, setLog] = useState<string[]>([]);
  const add = (s: string) => setLog((l) => [...l, s]);

  async function run(withPrf: boolean) {
    setLog([]);
    add(`origin: ${location.origin}`);
    add(`hostname: ${location.hostname}`);
    add(`rpId: ${rpId}`);
    add(`prf: ${withPrf}`);
    try {
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const publicKey: Record<string, unknown> = {
        challenge,
        rpId,
        userVerification: "preferred",
        timeout: 60_000,
      };
      if (withPrf) {
        publicKey.extensions = {
          prf: { eval: { first: b64urlToBytes("aHVudA") } },
        };
      }
      add("calling navigator.credentials.get() …");
      const cred = (await navigator.credentials.get({
        publicKey: publicKey as unknown as PublicKeyCredentialRequestOptions,
      })) as PublicKeyCredential | null;
      if (!cred) {
        add("RESULT: null (no credential)");
        return;
      }
      add(`SUCCESS ✓ credential id length: ${cred.rawId.byteLength}`);
      const prf = (
        cred.getClientExtensionResults() as { prf?: { enabled?: boolean } }
      ).prf;
      add(`prf enabled: ${JSON.stringify(prf?.enabled ?? "n/a")}`);
    } catch (e) {
      const err = e as { name?: string; message?: string };
      add(`ERROR name: ${err?.name ?? "(none)"}`);
      add(`ERROR message: ${err?.message ?? "(none)"}`);
      add(`ERROR string: ${String(e)}`);
    }
  }

  return (
    <main
      style={{
        maxWidth: 520,
        margin: "0 auto",
        padding: 16,
        fontFamily: "system-ui, sans-serif",
        color: "#e5e5e5",
        background: "#0a0a0a",
        minHeight: "100vh",
      }}
    >
      <h1 style={{ fontSize: 18 }}>Passkey diagnostic</h1>
      <p style={{ fontSize: 13, color: "#a1a1aa" }}>
        Runs a raw WebAuthn get() and prints the exact error. Nothing is sent
        anywhere.
      </p>
      <label style={{ display: "block", fontSize: 13, marginTop: 12 }}>
        rpId:
        <input
          value={rpId}
          onChange={(e) => setRpId(e.target.value)}
          style={{
            display: "block",
            width: "100%",
            padding: 10,
            marginTop: 4,
            fontSize: 16,
            background: "#1a1a1a",
            color: "#fff",
            border: "1px solid #333",
            borderRadius: 8,
          }}
        />
      </label>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button
          onClick={() => void run(false)}
          style={{
            flex: 1,
            padding: 14,
            fontSize: 15,
            borderRadius: 10,
            border: "none",
            background: "#22c55e",
            color: "#052e16",
            fontWeight: 600,
          }}
        >
          Test get()
        </button>
        <button
          onClick={() => void run(true)}
          style={{
            flex: 1,
            padding: 14,
            fontSize: 15,
            borderRadius: 10,
            border: "1px solid #333",
            background: "#1a1a1a",
            color: "#e5e5e5",
          }}
        >
          Test get() + PRF
        </button>
      </div>
      <pre
        style={{
          marginTop: 16,
          padding: 12,
          background: "#111",
          border: "1px solid #333",
          borderRadius: 8,
          fontSize: 13,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          minHeight: 120,
        }}
      >
        {log.length === 0 ? "(results appear here)" : log.join("\n")}
      </pre>
    </main>
  );
}
