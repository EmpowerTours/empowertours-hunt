"use client";

import { useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { LOCALES, type Locale } from "@/lib/i18n/config";

/**
 * Two taps, no menu.
 *
 * Geo picks the first language; this is how someone corrects it. It has to be
 * visible without scrolling and legible in daylight, because the person using
 * it is standing outdoors having just been shown a language they cannot read —
 * a switcher buried in a settings page is no switcher at all.
 *
 * `router.refresh()` rather than a reload: the locale is resolved server-side
 * per request, so re-rendering from the server is all that is needed, and it
 * keeps the GPS watch and any in-flight fix alive instead of restarting them.
 */
export function LanguageSwitch({ className }: { className?: string }) {
  const active = useLocale() as Locale;
  const t = useTranslations("language");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);

  async function choose(locale: Locale) {
    if (locale === active || pending) return;
    setFailed(false);
    try {
      const res = await fetch("/api/locale", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locale }),
      });
      if (!res.ok) throw new Error(String(res.status));
      startTransition(() => router.refresh());
    } catch {
      // Offline in a street with one bar. Say so quietly rather than leaving a
      // button that looks broken.
      setFailed(true);
    }
  }

  return (
    <div className={className}>
      <div
        role="group"
        aria-label={t("label")}
        className="border-hull-line inline-flex overflow-hidden rounded-full border"
      >
        {LOCALES.map((locale) => (
          <button
            key={locale}
            type="button"
            lang={locale}
            onClick={() => void choose(locale)}
            disabled={pending}
            aria-current={locale === active ? "true" : undefined}
            className={`px-3 py-1.5 font-mono text-xs tracking-wide transition-colors disabled:opacity-50 ${
              locale === active
                ? "bg-ink text-void"
                : "text-ink-dim hover:text-ink"
            }`}
          >
            {t(locale)}
          </button>
        ))}
      </div>
      {failed ? (
        <p className="text-ink-faint mt-1 font-mono text-[11px]">
          {t("switchedNote")}
        </p>
      ) : null}
    </div>
  );
}
