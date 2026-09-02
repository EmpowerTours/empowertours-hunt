"use client";

import { Providers } from "@/app/providers";
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
  return (
    <Providers signIn={signInWithPasskey} signer={claimSigner}>
      {children}
    </Providers>
  );
}
