"use client";

import { useEffect } from "react";
import { Providers } from "@/app/providers";
import { ensureCredentialCookie } from "./passkey";
import { claimSigner, signInWithPasskey } from "./signIn";

/**
 * Wires the auth lane's browser implementations into the UI lane's slots.
 *
 * app/providers.tsx deliberately takes `signIn` and `signer` as props so that
 * Mera-vs-Privy never leaks into a screen, and app/layout.tsx is a server
 * component, which cannot pass functions across the boundary. This client
 * component is that boundary: it is the one place the two lanes meet, and it is
 * the only file layout.tsx has to know about.
 *
 * Until this existed, `Providers` fell back to its NOT_WIRED defaults —
 * `canSignIn: false` and a `signIn` that throws — so nobody could sign in, no
 * Player row could be created, and the signed spawn-collect path was disabled.
 */
export function HuntAuthProvider({ children }: { children: React.ReactNode }) {
  // Seed the cross-subdomain passkey cookie from this origin's localStorage on
  // load. A player already signed in on hunt then carries the SAME wallet to
  // cota and turbo without a fresh ceremony; on an origin with no stored
  // credential (a sibling subdomain) this is a no-op. Lives in the auth lane
  // because the passkey credential is Mera's concern, not the UI's.
  useEffect(() => {
    ensureCredentialCookie();
  }, []);

  return (
    <Providers signIn={signInWithPasskey} signer={claimSigner}>
      {children}
    </Providers>
  );
}
