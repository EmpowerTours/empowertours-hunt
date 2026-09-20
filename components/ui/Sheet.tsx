"use client";

import { useEffect } from "react";

/* ---------------------------------------------------------------------------
   A list that outgrew its page.

   Both places this is used have the same shape: a panel whose job is to prove
   something — every payout is a real transaction, every leash either anchored
   or did not — and which therefore must not be truncated away, but which also
   must not become the whole screen. The answer in both is the newest few
   inline and the rest behind a tap.

   What is shared is the BEHAVIOUR, not the rows. The two lists render
   different things and even reach for their words differently (the wallet
   takes next-intl keys, the leash panel takes a `lang` prop), so labels are
   passed in and only the mechanics live here: escape, backdrop, scroll lock,
   the cap, and the one region allowed to scroll.
--------------------------------------------------------------------------- */

export function Sheet({
  open,
  onClose,
  label,
  closeLabel,
  heading,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** Accessible name for the dialog. */
  label: string;
  /** Accessible name for the close control. */
  closeLabel: string;
  /** Shown in the bar, typically a count. */
  heading: React.ReactNode;
  children: React.ReactNode;
}) {
  // Escape closes, and the page behind must not scroll while this is open. A
  // scrolling backdrop under a scrolling panel is how a phone loses track of
  // which one a thumb meant.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        // The backdrop closes; a tap inside must not travel up to it.
        onClick={(e) => e.stopPropagation()}
        className="border-hull-line bg-hull flex max-h-[80dvh] w-full max-w-md flex-col rounded-2xl border-2 shadow-2xl"
      >
        <div className="border-hull-line flex items-center justify-between gap-3 border-b p-4">
          <span className="text-ink-dim font-mono text-[11px] tracking-[0.24em] uppercase">
            {heading}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            autoFocus
            className="border-hull-line text-ink flex size-11 shrink-0 items-center justify-center rounded-xl border-2 text-lg"
          >
            ✕
          </button>
        </div>
        {/* The one scrolling region on the page while this is open. */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

/**
 * The button that opens one.
 *
 * Full width and 56px, because it is the only way to the rest of the list and
 * this is read one-handed, outdoors, possibly while walking.
 */
export function SheetOpener({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="border-hull-line text-ink active:bg-hull-2 mt-3 min-h-14 w-full rounded-2xl border-2 px-4 font-mono text-sm tracking-wider uppercase"
    >
      {children}
    </button>
  );
}
