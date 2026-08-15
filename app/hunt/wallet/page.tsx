import type { Metadata } from "next";
import Link from "next/link";
import { ProgressPanel } from "./ProgressPanel";

export const metadata: Metadata = { title: "Progress" };
export const dynamic = "force-dynamic";

export default function WalletPage() {
  return (
    <main className="safe-top safe-bottom mx-auto flex w-full max-w-md flex-col gap-4 px-4 pb-6">
      <header className="flex items-center justify-between gap-3 pt-2">
        <h1 className="text-ink text-2xl font-bold">Progress</h1>
        <Link
          href="/hunt"
          className="border-hull-line text-ink-dim flex min-h-11 items-center rounded-xl border px-3 font-mono text-xs tracking-widest uppercase"
        >
          Hunts
        </Link>
      </header>

      <ProgressPanel />
    </main>
  );
}
