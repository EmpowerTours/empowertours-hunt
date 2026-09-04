"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { useAuthSlot } from "@/app/providers";

// ---------------------------------------------------------------------------
// The claim screen. The song title is the button.
//
// Nobody claims an NFT here — they answer a question. The track asks "dime que
// sí"; the page is where they say it. That collapses the whole thing into one
// word a million people already heard, so there is no wallet vocabulary and no
// explanation of what a mint is — the passkey does the wallet silently, and the
// only decision on screen is Sí.
// ---------------------------------------------------------------------------

type Phase = "loading" | "ready" | "signing" | "claiming" | "done" | "error";

const T = {
  es: {
    q: "¿Dime que sí?",
    sub: "Unify34 · 2:19",
    si: "SÍ",
    signIn: "Toca SÍ para reclamar",
    signingIn: "Abriendo…",
    claiming: "Es tuya…",
    done: "Dijiste que sí 🎵",
    doneBody: "Dime Que Sí es tuya. Está en tu cartera, para siempre.",
    receipt: "ver en la cadena ↗",
    soldOut: "Ya se acabaron las gratis. Las de colección siguen abiertas.",
    closed: "El drop no está abierto ahorita.",
    retry: "Intentar de nuevo",
    error: "Algo falló. Intenta de nuevo.",
    remaining: (n: number) => `${n} gratis restantes`,
  },
  en: {
    q: "¿Dime que sí?",
    sub: "Unify34 · 2:19",
    si: "SÍ",
    signIn: "Tap SÍ to claim",
    signingIn: "Opening…",
    claiming: "Making it yours…",
    done: "You said yes 🎵",
    doneBody: "Dime Que Sí is yours. It's in your wallet, forever.",
    receipt: "see it on-chain ↗",
    soldOut: "The free ones are gone. Collector editions are still open.",
    closed: "The drop isn't open right now.",
    retry: "Try again",
    error: "Something went wrong. Try again.",
    remaining: (n: number) => `${n} free left`,
  },
} as const;

interface Status {
  open: boolean;
  remaining: number;
  mine: { status: string; transferTxHash: string | null } | null;
}

export default function DimePage() {
  const auth = useAuthSlot();
  const t = T[useLocale() === "es" ? "es" : "en"];

  const [phase, setPhase] = useState<Phase>("loading");
  const [status, setStatus] = useState<Status | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyStatus = useCallback(
    (body: Status) => {
      setStatus(body);
      if (body.mine?.status === "SENT") {
        setTxHash(body.mine.transferTxHash);
        setPhase("done");
      } else {
        setPhase("ready");
      }
    },
    [],
  );

  // Inline in the effect, guarded by `ignore`, so the setState calls happen
  // inside an awaited closure rather than synchronously in the effect body —
  // the same pattern the cota markets fetch uses.
  useEffect(() => {
    let ignore = false;
    void (async () => {
      try {
        const res = await fetch("/api/dime/claim");
        const body = (await res.json()) as Status;
        if (!ignore) applyStatus(body);
      } catch {
        if (!ignore) {
          setPhase("error");
          setError(t.error);
        }
      }
    })();
    return () => {
      ignore = true;
    };
  }, [applyStatus, t.error]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/dime/claim");
      applyStatus((await res.json()) as Status);
    } catch {
      /* the button already showed its own error */
    }
  }, [applyStatus]);

  const onSi = useCallback(async () => {
    setError(null);
    try {
      // Sign in first if needed — the passkey ceremony IS the wallet. One tap
      // creates it silently; the claimer never sees a seed phrase.
      if (auth.status !== "signed-in") {
        setPhase("signing");
        await auth.signIn();
      }
      setPhase("claiming");
      const res = await fetch("/api/dime/claim", { method: "POST" });
      const body = (await res.json()) as {
        ok?: boolean;
        transferTxHash?: string;
        error?: string;
      };
      if (!res.ok || !body.ok) {
        setPhase("error");
        setError(body.error ?? t.error);
        void refresh();
        return;
      }
      setTxHash(body.transferTxHash ?? null);
      setPhase("done");
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : t.error);
    }
  }, [auth, t.error, refresh]);

  const soldOut = status !== null && status.open && status.remaining <= 0;
  const closed = status !== null && !status.open;

  return (
    <main className="mx-auto flex min-h-[100svh] w-full max-w-sm flex-col items-center justify-center gap-6 px-6 py-10">
      {/* Cover art placeholder — a warm gradient standing in for the real
          artwork until the master's image is wired in. */}
      <div
        className="h-40 w-40 rounded-2xl"
        style={{
          background:
            "radial-gradient(circle at 30% 28%, #E4007C 0%, transparent 58%), radial-gradient(circle at 74% 72%, #ffd12e 0%, transparent 52%), #1a1024",
        }}
        aria-hidden
      />

      <div className="text-center">
        <h1 className="text-ink text-4xl font-black tracking-tight">{t.q}</h1>
        <p className="text-ink-faint mt-2 font-mono text-xs tracking-[0.2em] uppercase">
          {t.sub}
        </p>
      </div>

      {phase === "done" ? (
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="text-2xl font-bold text-[#4ade80]">{t.done}</div>
          <p className="text-ink-dim text-sm">{t.doneBody}</p>
          {txHash ? (
            <a
              href={`https://monadscan.com/tx/${txHash}`}
              target="_blank"
              rel="noreferrer noopener"
              className="font-mono text-xs text-[#E4007C] underline"
            >
              {t.receipt}
            </a>
          ) : null}
        </div>
      ) : closed ? (
        <p className="text-ink-dim text-center text-sm">{t.closed}</p>
      ) : soldOut ? (
        <p className="text-ink-dim text-center text-sm">{t.soldOut}</p>
      ) : (
        <>
          <button
            onClick={() => void onSi()}
            disabled={phase === "signing" || phase === "claiming"}
            className="min-h-16 w-full rounded-full bg-[#E4007C] text-3xl font-black tracking-widest text-white disabled:opacity-60"
          >
            {phase === "signing"
              ? t.signingIn
              : phase === "claiming"
                ? t.claiming
                : t.si}
          </button>
          <p className="text-ink-faint text-center text-xs">
            {status ? t.remaining(status.remaining) : ""}
          </p>
          {phase === "error" && error ? (
            <p className="text-alert text-center text-sm">{error}</p>
          ) : null}
        </>
      )}
    </main>
  );
}
