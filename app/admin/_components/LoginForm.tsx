"use client";

// Admin sign-in: EIP-4361 over an injected wallet.
//
// Not Mera (preview software) and not Privy. The operator console releases real
// MON, so its front door is a plain wallet signature over a message this server
// issued the nonce for, checked against the AdminUser table.
//
// The signature does not require the wallet to be connected to Monad —
// `personal_sign` is off-chain — but the message pins chainId 143 so a
// signature produced for another deployment cannot be replayed here.

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createSiweMessage } from "viem/siwe";
import { getAddress, toHex } from "viem";
import { adminPost } from "@/app/admin/_components/api";

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export function LoginForm() {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const provider = window.ethereum;
      if (!provider) {
        throw new Error(
          "no injected wallet found — open this console in a browser with your admin wallet installed",
        );
      }

      setStatus("requesting a challenge…");
      const nonceRes = await adminPost<{
        nonce: string;
        chainId: number;
        statement: string;
      }>("/api/admin/auth/nonce");
      if (!nonceRes.ok) throw new Error(nonceRes.error);

      setStatus("connecting wallet…");
      const accounts = (await provider.request({
        method: "eth_requestAccounts",
      })) as string[];
      const raw = accounts?.[0];
      if (!raw) throw new Error("wallet returned no account");
      const address = getAddress(raw);

      const message = createSiweMessage({
        address,
        chainId: nonceRes.data.chainId,
        domain: window.location.host,
        nonce: nonceRes.data.nonce,
        statement: nonceRes.data.statement,
        uri: window.location.origin,
        version: "1",
        issuedAt: new Date(),
      });

      setStatus("waiting for signature…");
      const signature = (await provider.request({
        method: "personal_sign",
        // Hex-encoded so wallets that treat a bare string as hex cannot mangle
        // the message before signing it.
        params: [toHex(message), address],
      })) as string;

      setStatus("verifying…");
      const login = await adminPost("/api/admin/auth/login", {
        message,
        signature,
      });
      if (!login.ok) throw new Error(login.error);

      setStatus("signed in");
      router.push("/admin");
      router.refresh();
    } catch (e) {
      setStatus(null);
      setError(e instanceof Error ? e.message : "sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mt-16 max-w-md rounded border border-slate-800 bg-slate-900/50 p-6">
      <h1 className="text-base font-semibold text-slate-100">
        Operator console
      </h1>
      <p className="mt-2 text-xs leading-relaxed text-slate-400">
        Sign in with the wallet registered as an admin. This console approves
        payouts of real native MON on Monad mainnet and shows cache coordinates,
        which never appear anywhere a player can reach.
      </p>

      <button
        type="button"
        onClick={signIn}
        disabled={busy}
        className="mt-4 w-full rounded bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-900 hover:bg-white disabled:opacity-50"
      >
        {busy ? "…" : "Sign in with wallet"}
      </button>

      {status && <p className="mt-3 text-xs text-slate-500">{status}</p>}
      {error && (
        <p className="mt-3 rounded border border-red-800 bg-red-950/50 px-2 py-1.5 text-xs text-red-200">
          {error}
        </p>
      )}
    </div>
  );
}
