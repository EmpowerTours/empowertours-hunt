// Operator-console primitives.
//
// Information-first, deliberately not the player app's radar styling: dense
// tables, tabular numerals, no animation, no decorative colour. Colour here
// carries one meaning only — state — so that a red row is always a problem and
// never a theme.
//
// All server components. Nothing in this file needs interactivity.

import type { ReactNode } from "react";

export function Panel({
  title,
  subtitle,
  actions,
  children,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded border border-slate-800 bg-slate-900/40">
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-800 px-3 py-2">
          <div>
            {title && (
              <h2 className="text-sm font-semibold tracking-wide text-slate-200">
                {title}
              </h2>
            )}
            {subtitle && (
              <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-slate-500">
                {subtitle}
              </p>
            )}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-3">{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  const toneClass = {
    neutral: "text-slate-100",
    good: "text-emerald-300",
    warn: "text-amber-300",
    bad: "text-red-300",
  }[tone];
  return (
    <div className="rounded border border-slate-800 bg-slate-900/60 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wider text-slate-500">
        {label}
      </div>
      <div className={`mt-1 font-mono text-lg tabular-nums ${toneClass}`}>
        {value}
      </div>
      {hint && (
        <div className="mt-1 text-[11px] leading-snug text-slate-500">
          {hint}
        </div>
      )}
    </div>
  );
}

const BADGE_TONES = {
  neutral: "border-slate-700 bg-slate-800 text-slate-300",
  good: "border-emerald-800 bg-emerald-950 text-emerald-300",
  warn: "border-amber-800 bg-amber-950 text-amber-300",
  bad: "border-red-800 bg-red-950 text-red-300",
  alarm: "border-red-500 bg-red-900 text-red-100",
} as const;

export function Badge({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: keyof typeof BADGE_TONES;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${BADGE_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/** Explains what a control costs when loosened. Operators are not mind readers. */
export function Explain({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
      {children}
    </p>
  );
}

export function Warning({ children }: { children: ReactNode }) {
  return (
    <div className="rounded border border-amber-800 bg-amber-950/40 px-3 py-2 text-xs leading-relaxed text-amber-200">
      {children}
    </div>
  );
}

export function Danger({ children }: { children: ReactNode }) {
  return (
    <div className="rounded border border-red-600 bg-red-950/60 px-3 py-2 text-xs leading-relaxed text-red-100">
      {children}
    </div>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  );
}

export function Th({
  children,
  align = "left",
}: {
  children: ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={`border-b border-slate-800 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500 ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = "left",
  mono = false,
}: {
  children: ReactNode;
  align?: "left" | "right";
  mono?: boolean;
}) {
  return (
    <td
      className={`border-b border-slate-900 px-2 py-1.5 align-top text-slate-300 ${
        align === "right" ? "text-right" : "text-left"
      } ${mono ? "font-mono tabular-nums" : ""}`}
    >
      {children}
    </td>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 py-6 text-center text-xs text-slate-600">
      {children}
    </div>
  );
}

export function Pager({
  page,
  take,
  total,
  hrefFor,
}: {
  page: number;
  take: number;
  total: number;
  hrefFor: (page: number) => string;
}) {
  const pages = Math.max(1, Math.ceil(total / take));
  const from = total === 0 ? 0 : (page - 1) * take + 1;
  const to = Math.min(page * take, total);
  return (
    <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
      <span className="font-mono tabular-nums">
        {from}–{to} of {total}
      </span>
      <span className="flex items-center gap-2">
        {page > 1 ? (
          <a
            className="rounded border border-slate-700 px-2 py-0.5 hover:bg-slate-800"
            href={hrefFor(page - 1)}
          >
            prev
          </a>
        ) : (
          <span className="rounded border border-slate-900 px-2 py-0.5 text-slate-700">
            prev
          </span>
        )}
        <span className="font-mono tabular-nums">
          {page}/{pages}
        </span>
        {page < pages ? (
          <a
            className="rounded border border-slate-700 px-2 py-0.5 hover:bg-slate-800"
            href={hrefFor(page + 1)}
          >
            next
          </a>
        ) : (
          <span className="rounded border border-slate-900 px-2 py-0.5 text-slate-700">
            next
          </span>
        )}
      </span>
    </div>
  );
}

export function KeyVal({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex gap-2 py-0.5 text-xs">
      <span className="w-44 shrink-0 text-slate-500">{k}</span>
      <span className="font-mono tabular-nums text-slate-300">{v}</span>
    </div>
  );
}
