import Link from "next/link";

/* ---------------------------------------------------------------------------
   Shared chrome.

   Sizing is set by the use case, not by taste: this is read at arm's length,
   outdoors, in sunlight, one-handed, possibly while walking. Every interactive
   element is at least 56px tall, nothing depends on hover, and no text that
   matters is below 14px.
--------------------------------------------------------------------------- */

type ButtonTone = "primary" | "danger" | "ghost";

const TONES: Record<ButtonTone, string> = {
  primary:
    "bg-phosphor text-void border-phosphor active:bg-phosphor/80 disabled:bg-hull-2 disabled:text-ink-faint disabled:border-hull-line",
  danger:
    "bg-alert text-white border-alert active:bg-alert/80 disabled:bg-hull-2 disabled:text-ink-faint disabled:border-hull-line",
  ghost:
    "bg-transparent text-ink border-hull-line active:bg-hull-2 disabled:text-ink-faint",
};

// React 19 treats `ref` as an ordinary prop, and ComponentProps<"button">
// includes it — so this forwards a ref without forwardRef.
export function Button({
  tone = "primary",
  className = "",
  ...props
}: React.ComponentProps<"button"> & { tone?: ButtonTone }) {
  return (
    <button
      {...props}
      className={`min-h-14 w-full rounded-2xl border-2 px-5 text-lg font-semibold tracking-wide transition-colors disabled:cursor-not-allowed ${TONES[tone]} ${className}`}
    />
  );
}

export function LinkButton({
  href,
  tone = "ghost",
  className = "",
  children,
}: {
  href: string;
  tone?: ButtonTone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`flex min-h-14 w-full items-center justify-center rounded-2xl border-2 px-5 text-lg font-semibold tracking-wide ${TONES[tone]} ${className}`}
    >
      {children}
    </Link>
  );
}

export function Panel({
  className = "",
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`border-hull-line bg-hull rounded-2xl border p-4 ${className}`}
    >
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "credit" | "mon" | "warn";
}) {
  const valueTone =
    tone === "credit"
      ? "text-phosphor"
      : tone === "mon"
        ? "text-spawn"
        : tone === "warn"
          ? "text-alert"
          : "text-ink";
  return (
    <div className="border-hull-line bg-hull-2/40 rounded-xl border p-3">
      <div className="text-ink-dim font-mono text-[11px] tracking-[0.18em] uppercase">
        {label}
      </div>
      <div className={`mt-1 font-mono text-2xl leading-none ${valueTone}`}>
        {value}
      </div>
      {sub ? <div className="text-ink-faint mt-1 text-xs">{sub}</div> : null}
    </div>
  );
}

export function Pill({
  children,
  color,
  className = "",
}: {
  children: React.ReactNode;
  color?: string;
  className?: string;
}) {
  return (
    <span
      className={`border-hull-line inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-xs tracking-widest uppercase ${className}`}
      style={color ? { color, borderColor: `${color}66` } : undefined}
    >
      {children}
    </span>
  );
}

/** A non-alarming note. `tone="warn"` for anything that will block a claim. */
export function Note({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warn" | "stop";
  title?: string;
  children: React.ReactNode;
}) {
  const border =
    tone === "stop"
      ? "border-alert/70"
      : tone === "warn"
        ? "border-band-hot/70"
        : "border-hull-line";
  const heading =
    tone === "stop"
      ? "text-alert"
      : tone === "warn"
        ? "text-band-hot"
        : "text-ink-dim";
  return (
    <div className={`bg-hull-2/50 rounded-xl border-l-4 p-3 ${border}`}>
      {title ? (
        <div
          className={`font-mono text-xs tracking-[0.16em] uppercase ${heading}`}
        >
          {title}
        </div>
      ) : null}
      <div className="text-ink mt-1 text-sm leading-snug">{children}</div>
    </div>
  );
}

/** Screen-reader-only text — used for the live band announcement. */
export function SrOnly({ children }: { children: React.ReactNode }) {
  return <span className="sr-only">{children}</span>;
}
