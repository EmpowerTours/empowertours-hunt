"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { formatMon, weiOrZero } from "./format";

/* ---------------------------------------------------------------------------
   You bumped into an artist.

   An INTERRUPT, deliberately: it covers the scope the moment it arrives,
   because an offer you have to go looking for is one nobody finds. The cost
   is that it lands mid-walk, and on the live hunt a spawn expires in ninety
   seconds — so declining is ONE tap, the card never covers the claim button,
   and "no" is answered locally before the request goes out.

   It is not a blip and there is nowhere to walk to. The work is bought from
   wherever the hunter is standing.
--------------------------------------------------------------------------- */

export interface EditionOfferView {
  id: string;
  masterId: string;
  kind: "MUSIC" | "ART" | string;
  tier: string;
  terms: string;
  priceWei: string | null;
  expiresAt: string;
  name: string;
  imageUrl: string | null;
  previewUrl: string | null;
}

const T = {
  es: {
    bumped: "Te topaste con un artista",
    sellingMusic: "Está vendiendo su música",
    sellingArt: "Está vendiendo su arte",
    free: "Gratis",
    yes: "Comprar",
    yesFree: "Reclamar",
    no: "Ahora no",
    buying: "Comprando…",
    signing: "Confirma con tu passkey…",
    alreadyHeld: "Puede que ya tengas una licencia de esta obra.",
    buyAnyway: "Comprar de todos modos",
    preview: "Escuchar 3s",
    stop: "Detener",
    short: "Te faltan {amount} MON",
    shortHint: "Sigue cazando — se guarda hasta que lo tengas.",
    failed: "No se pudo completar. No se te cobró.",
    paid: "Pagaste pero falló la entrega. Lo vamos a resolver.",
    yours: "¡Es tuya!",
    inWallet: "Está en tu cartera.",
  },
  en: {
    bumped: "You bumped into an artist",
    sellingMusic: "They're selling their music",
    sellingArt: "They're selling their art",
    free: "Free",
    yes: "Buy",
    yesFree: "Claim",
    no: "Not now",
    buying: "Buying…",
    signing: "Confirm with your passkey…",
    alreadyHeld: "You may already hold a licence for this work.",
    buyAnyway: "Buy anyway",
    preview: "Hear 3s",
    stop: "Stop",
    short: "You need {amount} more MON",
    shortHint: "Keep hunting — it will still be here.",
    failed: "Could not complete. You were not charged.",
    paid: "You paid but delivery failed. We will sort it out.",
    yours: "It's yours!",
    inWallet: "It's in your wallet.",
  },
} as const;

type Phase = "asking" | "signing" | "buying" | "done" | "error";

export function EditionCard({
  offer,
  payTo,
  alreadyHeld,
  walletBalanceWei,
  gasBufferWei,
  onAnswer,
  pay,
}: {
  offer: EditionOfferView;
  /** Where the payment goes. Null means the relayer is unconfigured. */
  payTo: string | null;
  alreadyHeld: boolean;
  /**
   * What the wallet held when the server last looked, and the headroom a
   * transfer needs on top of the price.
   *
   * Null means the chain could not be read. That is NOT zero: a card must
   * never tell somebody they are short because an RPC timed out, so an
   * unreadable balance leaves BUY enabled and lets the signing step be the
   * one that refuses.
   */
  walletBalanceWei: string | null;
  gasBufferWei: string | null;
  /** Posts the answer. Resolves to the server's verdict. */
  onAnswer: (
    answer: "yes" | "no",
    paymentTxHash?: string,
  ) => Promise<{ ok: boolean; reason?: string }>;
  /** Sends native MON from the passkey wallet, returning the tx hash. */
  pay: (to: `0x${string}`, valueWei: bigint) => Promise<`0x${string}`>;
}) {
  const t = T[useLocale() === "es" ? "es" : "en"];
  const [phase, setPhase] = useState<Phase>("asking");
  const [message, setMessage] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  const free = offer.terms === "FREE";
  const priceWei = weiOrZero(offer.priceWei ?? "0");

  // ---- Can they actually pay for this?
  //
  // Worth stating because the card is now shown for works the hunter cannot
  // afford: the placement filter is optional per hunt, since filtering them
  // out emptied the pool entirely and no card is worse than a card they
  // cannot tap yet. The honesty has to live here instead.
  //
  // A FREE work needs nothing — the relayer signs both transactions. For a
  // purchase they need the price PLUS gas, because they sign the transfer
  // themselves and Monad charges the whole gas limit with no refund.
  //
  // Reject by default is the WRONG default here, deliberately. An unreadable
  // balance leaves BUY enabled: being told "you are short" because an RPC
  // timed out is a worse failure than a signing prompt that declines, and the
  // signing step cannot be fooled by a stale number the way this can.
  const needWei =
    walletBalanceWei === null || gasBufferWei === null
      ? null
      : priceWei + weiOrZero(gasBufferWei) - weiOrZero(walletBalanceWei);
  const shortWei = free || needWei === null || needWei <= 0n ? null : needWei;

  // Stop the preview on unmount. A 3s clip still playing after the card is
  // gone is somebody's phone making noise for no reason.
  useEffect(() => {
    const el = audioRef.current;
    return () => {
      el?.pause();
    };
  }, []);

  const togglePreview = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      setPlaying(false);
    } else {
      void el.play().then(
        () => setPlaying(true),
        () => setPlaying(false),
      );
    }
  }, [playing]);

  const decline = useCallback(() => {
    // Close first, answer after. The card is gone the instant they tap — a
    // dismissal that waits on the network is a dismissal that feels broken
    // while a spawn is ticking down behind it.
    void onAnswer("no");
  }, [onAnswer]);

  const accept = useCallback(async () => {
    try {
      let hash: string | undefined;
      if (!free) {
        if (!payTo) {
          setPhase("error");
          setMessage(t.failed);
          return;
        }
        setPhase("signing");
        hash = await pay(payTo as `0x${string}`, priceWei);
      }
      setPhase("buying");
      const res = await onAnswer("yes", hash);
      if (res.ok) {
        setPhase("done");
        return;
      }
      setPhase("error");
      // A failure AFTER the money moved reads differently from one before it.
      setMessage(res.reason === "relay_failed" ? t.paid : t.failed);
    } catch {
      // A rejected passkey prompt or a wallet with too little for gas. No
      // money moved, so say so plainly.
      setPhase("error");
      setMessage(t.failed);
    }
  }, [free, payTo, pay, priceWei, onAnswer, t]);

  const busy = phase === "signing" || phase === "buying";
  // Short is not "busy": the button is dead, not thinking. Kept separate so
  // the decline button stays untouched — the way out is never the harder tap.
  const blocked = busy || shortWei !== null;

  return (
    <div
      className="safe-top safe-bottom fixed inset-0 z-40 flex items-center justify-center bg-black/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t.bumped}
    >
      <div className="border-phosphor/40 bg-hull w-full max-w-sm rounded-2xl border-2 p-4 shadow-2xl">
        <div className="text-phosphor font-mono text-[11px] tracking-[0.24em] uppercase">
          {t.bumped}
        </div>
        <p className="text-ink-dim mt-1 text-sm">
          {offer.kind === "ART" ? t.sellingArt : t.sellingMusic}
        </p>

        <div className="mt-3 flex items-center gap-3">
          {offer.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={offer.imageUrl}
              alt=""
              className="border-hull-line size-20 shrink-0 rounded-xl border object-cover"
            />
          ) : (
            <div className="border-hull-line bg-hull-2 size-20 shrink-0 rounded-xl border" />
          )}
          <div className="min-w-0">
            <div className="text-ink truncate text-lg font-bold">
              {offer.name}
            </div>
            <div className="text-spawn mt-1 font-mono text-2xl leading-none">
              {free ? t.free : `${formatMon(priceWei)} MON`}
            </div>
          </div>
        </div>

        {/* Loaded on tap, never on sight: the venue serves an uncompressed
            WAV, about 576 KB for three seconds, and this runs on mobile data
            in Guerrero. */}
        {offer.previewUrl ? (
          <>
            <audio
              ref={audioRef}
              src={offer.previewUrl}
              preload="none"
              onEnded={() => setPlaying(false)}
            />
            <button
              type="button"
              onClick={togglePreview}
              className="border-hull-line text-ink-dim mt-3 min-h-11 w-full rounded-xl border px-3 font-mono text-xs tracking-wider uppercase"
            >
              {playing ? t.stop : t.preview}
            </button>
          </>
        ) : null}

        {shortWei !== null && phase === "asking" ? (
          <p className="text-band-hot mt-3 text-xs leading-snug">
            {t.short.replace("{amount}", formatMon(shortWei))}
            <br />
            <span className="text-ink-dim">{t.shortHint}</span>
          </p>
        ) : null}

        {alreadyHeld && phase === "asking" ? (
          <p className="text-band-hot mt-3 text-xs leading-snug">
            {t.alreadyHeld}
          </p>
        ) : null}

        {phase === "done" ? (
          <div className="mt-4">
            <div className="text-spawn text-lg font-bold">{t.yours}</div>
            <p className="text-ink-dim mt-1 text-sm">{t.inWallet}</p>
            <button
              type="button"
              onClick={() => void onAnswer("no")}
              className="bg-spawn text-void mt-3 min-h-14 w-full rounded-2xl text-lg font-semibold"
            >
              OK
            </button>
          </div>
        ) : (
          <>
            {message ? (
              <p className="text-alert mt-3 text-sm leading-snug">{message}</p>
            ) : null}
            <div className="mt-4 grid grid-cols-2 gap-2">
              {/* Decline is first in the DOM and always enabled: the way out
                  must never be the harder tap, and never blocked by a
                  purchase that is still thinking. */}
              <button
                type="button"
                onClick={decline}
                className="border-hull-line text-ink min-h-14 w-full rounded-2xl border-2 text-base font-semibold"
              >
                {t.no}
              </button>
              <button
                type="button"
                onClick={() => void accept()}
                disabled={blocked}
                className="bg-spawn text-void min-h-14 w-full rounded-2xl text-base font-semibold disabled:opacity-50"
              >
                {phase === "signing"
                  ? t.signing
                  : phase === "buying"
                    ? t.buying
                    : alreadyHeld
                      ? t.buyAnyway
                      : free
                        ? t.yesFree
                        : t.yes}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
