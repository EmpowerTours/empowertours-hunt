"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { useAuthSlot } from "@/app/providers";
import { inAppWebView } from "@/lib/app-shell";
import { thumbSrcSet, thumbUrl } from "@/lib/editions/thumb";

// ---------------------------------------------------------------------------
// The claim screen. The song title is the button.
//
// Nobody claims an NFT here — they answer a question. The track asks "dime que
// sí"; the page is where they say it. That collapses the whole thing into one
// word a million people already heard, so there is no wallet vocabulary and no
// explanation of what a mint is — the passkey does the wallet silently, and the
// only decision on screen is Sí.
// ---------------------------------------------------------------------------

/** The cover frame, in CSS pixels. Must match the h-40 w-40 below (10rem). */
const COVER_PX = 160;

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
    mine: "Ver lo que tienes →",
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
    mine: "See what you own →",
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
  /** Resolved from the venue catalogue. Null when it could not be read. */
  art?: { name: string; imageUrl: string | null } | null;
}

export default function DimePage() {
  const auth = useAuthSlot();
  const t = T[useLocale() === "es" ? "es" : "en"];

  const [phase, setPhase] = useState<Phase>("loading");
  const [status, setStatus] = useState<Status | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [coverLoaded, setCoverLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyStatus = useCallback((body: Status) => {
    setStatus(body);
    if (body.mine?.status === "SENT") {
      setTxHash(body.mine.transferTxHash);
      setPhase("done");
    } else {
      setPhase("ready");
    }
  }, []);

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
      //
      // A first-time claimer has no passkey to assert, so the assertion throws
      // NoPasskeyFoundError, whose message tells them to "make a new wallet
      // below" — and this page has no below, and must not grow one: the only
      // decision on screen is Sí. So make the wallet here. Matching the flag
      // rather than the text keeps this working if the copy changes.
      //
      // NOT inside the app's WebView. There, "no passkey found" is ambiguous:
      // it is equally the symptom of the asset-links/WebView path being wrong
      // on a phone that DOES hold a passkey in Google Password Manager. A
      // wallet is a passkey, so creating one on that guess hands the claimer a
      // second address and quietly strands whatever is in the first. In a
      // browser the lookup is trustworthy, so the silent create stays.
      if (auth.status !== "signed-in") {
        setPhase("signing");
        try {
          await auth.signIn();
        } catch (e: unknown) {
          const canCreate =
            typeof e === "object" &&
            e !== null &&
            (e as { canCreateWallet?: unknown }).canCreateWallet === true;
          if (!canCreate || inAppWebView()) throw e;
          await auth.createWallet();
        }
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
    <main className="safe-top safe-bottom mx-auto flex min-h-[100svh] w-full max-w-sm flex-col items-center justify-center gap-6 px-6 py-10">
      {/* The real cover, with the gradient still underneath it.
          The gradient used to BE the artwork — a stand-in that shipped on a
          page built to convert cold traffic. It stays as the backdrop rather
          than being deleted: it fills the frame while the image loads, and it
          is what remains if the catalogue could not be read or the gateway is
          slow, so this frame is never an empty box. */}
      <div
        className="relative h-40 w-40 overflow-hidden rounded-2xl"
        style={{
          background:
            "radial-gradient(circle at 30% 28%, #E4007C 0%, transparent 58%), radial-gradient(circle at 74% 72%, #ffd12e 0%, transparent 52%), #1a1024",
        }}
      >
        {status?.art?.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            // COVER_PX, not the original. The master is 1024x1024 and 197KB
            // going into a 160px frame; asking the gateway for 320 brings that
            // to 15KB. See lib/editions/thumb.ts for the measurements.
            src={thumbUrl(status.art.imageUrl, COVER_PX * 2) ?? undefined}
            // Width descriptors so a 3x phone takes the 480 and a 2x phone the
            // 320, rather than everyone paying for the larger. Null when the
            // gateway cannot resize, in which case src is the original and a
            // srcSet would be that same file listed twice.
            srcSet={thumbSrcSet(status.art.imageUrl, COVER_PX) ?? undefined}
            sizes={`${COVER_PX}px`}
            alt={status.art.name}
            width={COVER_PX}
            height={COVER_PX}
            className="h-full w-full object-cover transition-opacity duration-500"
            style={{ opacity: coverLoaded ? 1 : 0 }}
            onLoad={() => setCoverLoaded(true)}
            // A broken gateway must not leave a half-drawn image over the
            // gradient; hiding it restores the fallback exactly.
            onError={() => setCoverLoaded(false)}
          />
        ) : null}
      </div>

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
          {/* Somewhere to go next, which this screen did not have.
              A claimer arrived from a social post, tapped once, and the only
              onward link was a block explorer — a page that answers "did the
              transaction happen", not "what do I now own". The wallet shows
              the record with its cover, which is the thing worth coming back
              to and the only reason any of them would. */}
          <Link
            href="/hunt/wallet"
            className="mt-2 min-h-11 rounded-full border border-current px-5 py-2 text-sm font-medium"
          >
            {t.mine}
          </Link>
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
