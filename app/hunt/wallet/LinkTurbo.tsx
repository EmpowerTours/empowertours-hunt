"use client";

// Attaching a TURBO builder handle to this wallet.
//
// The screen this replaces was a dead end: a Note saying credit "can only be
// redeemed once a TURBO registry handle is linked to this wallet", with
// nothing anywhere in the app that could link one. `lib/auth/signIn.ts` sends
// an empty handle at registration and no route wrote it afterwards, so every
// player has had a null handle and been told to fix something they could not
// reach.
//
// SET ONCE, and the copy says so before the tap rather than after. The server
// is what enforces it (a conditional UPDATE plus a unique index); this is the
// warning, not the control.

import { useState } from "react";
import { useTranslations } from "next-intl";
import { linkTurboHandle } from "@/components/hunt/client";
import { Note } from "@/components/ui/primitives";

export function LinkTurbo({
  onLinked,
}: {
  onLinked: (handle: string) => void;
}) {
  const t = useTranslations("wallet");
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = handle.trim().replace(/^@+/, "");

  async function submit() {
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    const res = await linkTurboHandle(trimmed);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? t("linkFailed"));
      return;
    }
    // The server's version, not the typed one: it lowercases, and showing the
    // stored value is what makes the next screen agree with this one.
    onLinked(res.handle ?? trimmed);
  }

  return (
    <Note title={t("noHandleTitle")}>
      <p>{t("noHandleBody")}</p>
      <p className="text-ink-faint mt-2 text-xs">{t("linkOnceWarning")}</p>
      <div className="mt-3 flex gap-2">
        <input
          className="border-hull-line bg-hull-2 text-ink min-h-11 w-full rounded-xl border px-3 font-mono text-sm"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder={t("handlePlaceholder")}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          aria-label={t("turboHandle")}
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || trimmed.length === 0}
          className="bg-spawn text-void min-h-11 shrink-0 rounded-xl px-4 text-sm font-semibold disabled:opacity-50"
        >
          {busy ? t("linking") : t("link")}
        </button>
      </div>
      {error ? (
        <p className="text-alert mt-2 text-xs leading-snug">{error}</p>
      ) : null}
    </Note>
  );
}
