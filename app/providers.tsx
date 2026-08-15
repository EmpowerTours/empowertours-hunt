"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { endSession, fetchSession } from "@/components/hunt/client";
import type { ClaimMessage, ClaimSigner } from "@/components/hunt/types";

/* ---------------------------------------------------------------------------
   Provider slots.

   The UI lane does not own authentication. `lib/auth/**` is the auth lane's,
   and Mera-vs-Privy must not leak into a screen. Two things are separated here:

   * SESSION STATE is read from the real endpoint (`GET /api/auth/session`),
     because that is a plain HTTP call and pretending not to know whether the
     player is signed in would be worse than useless.
   * SIGNING IN and SIGNING A CLAIM are slots. Mera derives its key from a
     passkey's PRF output in the browser, so those need a client module the
     auth lane owns. Until one is registered, both fail honestly rather than
     appearing to work.

   TO WIRE THE AUTH LANE IN: pass `signIn` and `signer` to `<Providers>` in
   app/layout.tsx, or replace this file's defaults. Nothing under
   `components/**` needs to change either way.
--------------------------------------------------------------------------- */

export type AuthStatus =
  | "loading"
  | "signed-out"
  | "signed-in"
  /** Signed in, but the wallet is suspended or deactivated. */
  | "blocked";

export interface AuthSlotValue {
  status: AuthStatus;
  /** Lowercased wallet address once known. */
  walletAddress: string | null;
  displayName: string | null;
  /** True when a real sign-in implementation has been registered. */
  canSignIn: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => void;
}

const NOT_WIRED: AuthSlotValue = {
  status: "signed-out",
  walletAddress: null,
  displayName: null,
  canSignIn: false,
  signIn: async () => {
    throw new Error(
      "Passkey sign-in is not wired up in this build (auth lane owns the browser-side Mera flow).",
    );
  },
  signOut: async () => {},
  refresh: () => {},
};

const AuthSlotContext = createContext<AuthSlotValue>(NOT_WIRED);

export function useAuthSlot(): AuthSlotValue {
  return useContext(AuthSlotContext);
}

/* --------------------------------------------------------------------------
   EIP-712 signing slot.

   AGENTS.md and lib/auth/eip712.ts pin the typed data:
     domain: { name: "EmpowerToursHunt", version: "1", chainId: 143 }
     ClaimAttempt: { huntId string, lat string, lng string, accuracyM string,
                     clientTs uint256, nonce string }

   `POST /api/hunt/[huntId]/spawn/collect` REQUIRES a signature — that path
   moves real MON — so with no signer registered the UI disables collection and
   says why. The claim route still accepts an unsigned body; when a signer is
   present the signature rides along so the route can start requiring one
   without a call site changing.
-------------------------------------------------------------------------- */

const ClaimSignerContext = createContext<ClaimSigner | null>(null);

export function useClaimSigner(): ClaimSigner | null {
  return useContext(ClaimSignerContext);
}

export type { ClaimMessage, ClaimSigner };

/* --------------------------------------------------------------------------
   Session probe
-------------------------------------------------------------------------- */

interface SessionState {
  status: AuthStatus;
  walletAddress: string | null;
}

function useSession(): SessionState & { refresh: () => void } {
  const [state, setState] = useState<SessionState>({
    status: "loading",
    walletAddress: null,
  });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetchSession(controller.signal)
      .then((player) => {
        if (controller.signal.aborted) return;
        if (player === null) {
          setState({ status: "signed-out", walletAddress: null });
          return;
        }
        setState({
          // Reject by default: only an explicitly active, unsuspended player
          // counts as signed in. Anything else is `blocked`, so the UI never
          // invites an ineligible wallet to walk somewhere for nothing.
          status: player.active && !player.suspended ? "signed-in" : "blocked",
          walletAddress: player.walletAddress,
        });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setState({ status: "signed-out", walletAddress: null });
      });
    return () => controller.abort();
  }, [nonce]);

  return { ...state, refresh: () => setNonce((n) => n + 1) };
}

export function Providers({
  children,
  signIn,
  signer,
}: {
  children: React.ReactNode;
  /** Registered by the auth lane. Absent means sign-in is not available. */
  signIn?: () => Promise<void>;
  /** Registered by the auth lane. Absent means MON collection is disabled. */
  signer?: ClaimSigner;
}) {
  const session = useSession();
  const { refresh } = session;

  const signOut = useCallback(async () => {
    await endSession();
    refresh();
  }, [refresh]);

  const auth = useMemo<AuthSlotValue>(
    () => ({
      status: session.status,
      walletAddress: session.walletAddress,
      displayName: null,
      canSignIn: signIn !== undefined,
      signIn: signIn ?? NOT_WIRED.signIn,
      signOut,
      refresh,
    }),
    [session.status, session.walletAddress, signIn, signOut, refresh],
  );

  return (
    <AuthSlotContext.Provider value={auth}>
      <ClaimSignerContext.Provider value={signer ?? null}>
        {children}
      </ClaimSignerContext.Provider>
    </AuthSlotContext.Provider>
  );
}
