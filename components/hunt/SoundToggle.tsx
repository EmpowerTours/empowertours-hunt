"use client";

import { useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import {
  isMuted,
  isMutedOnServer,
  playChime,
  setMuted,
  subscribeMuted,
  unlockAudio,
} from "@/lib/hunt/chime";

/**
 * One tap, next to the language pill.
 *
 * It sits at the foot of the scroller rather than the header for the reason
 * written on the header itself: at 360px the header cannot afford another
 * control without crushing the hunt name.
 *
 * `useSyncExternalStore` rather than `useState` + `useEffect`: the setting
 * lives in localStorage, which the server cannot see, so reading it during
 * render would hydration-mismatch. The server snapshot says "not muted" and
 * the client corrects it on mount.
 *
 * Turning sound ON plays the chime immediately. That is not a flourish — it is
 * the only way to find out whether your phone will actually make the noise,
 * and it doubles as the gesture that unlocks audio on iOS.
 */
export function SoundToggle({
  className,
  compact = false,
}: {
  className?: string;
  /**
   * Icon only, for the header. The header is the width-critical row — adding
   * the language pill there once crushed the hunt name to "Bús..." and wrapped
   * the status onto three lines — so this variant is a single glyph in a 44px
   * touch target, and the meaning lives in aria-label instead of a word.
   */
  compact?: boolean;
}) {
  const t = useTranslations("sound");
  const mutedNow = useSyncExternalStore(
    subscribeMuted,
    isMuted,
    isMutedOnServer,
  );

  function toggle() {
    const next = !mutedNow;
    setMuted(next);
    if (!next) {
      // Unmuting is itself a user gesture, so this is the right moment to let
      // iOS start the audio context, and the player gets to hear what they
      // just switched on.
      unlockAudio();
      // The ALERT, not the collect chime. Turning sound on is the one moment
      // a player is deliberately testing audio, and the sound they need to
      // trust is the one that fires while the phone is in a pocket — the
      // collect chime is loud and plays in the hand, so it proved nothing.
      // A whole evening was spent chasing "no alarm sound" with a working
      // toggle, because the toggle was demonstrating a different sound.
      playChime("spawn");
    }
  }

  if (compact) {
    return (
      <button
        type="button"
        onClick={toggle}
        aria-pressed={!mutedNow}
        aria-label={mutedNow ? t("off") : t("on")}
        title={mutedNow ? t("off") : t("on")}
        className={`border-hull-line flex min-h-11 w-11 shrink-0 items-center justify-center rounded-xl border text-base transition-colors ${
          mutedNow ? "text-ink-faint" : "text-ink-dim hover:text-ink"
        } ${className ?? ""}`}
      >
        <span aria-hidden="true">{mutedNow ? "\u266a\u0338" : "\u266a"}</span>
      </button>
    );
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={toggle}
        aria-pressed={!mutedNow}
        aria-label={t("label")}
        className="border-hull-line text-ink-dim hover:text-ink inline-flex min-h-11 items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-xs tracking-wide transition-colors"
      >
        <span aria-hidden="true">{mutedNow ? "×" : "♪"}</span>
        {mutedNow ? t("off") : t("on")}
      </button>
    </div>
  );
}
