// Admin chrome. Nested under the root layout — this file does NOT own <html>
// or <body>, and does not touch app/globals.css.
//
// The wrapper sets its own background and text colour explicitly so the player
// app's radar styling cannot bleed into a screen where misreading a number
// costs money.
//
// Nothing is gated here. The layout renders for /admin/login too, so auth is
// enforced per page (and, more importantly, per API route) rather than by a
// layout that a route handler never passes through.

import type { ReactNode } from "react";
import { AdminRole } from "@prisma/client";
import { getAdminSession, roleAtLeast } from "@/lib/admin/auth";
import { shortAddress } from "@/lib/admin/format";
import { LogoutButton } from "@/app/admin/_components/LogoutButton";

export const dynamic = "force-dynamic";

const NAV: Array<{ href: string; label: string; min: AdminRole }> = [
  { href: "/admin", label: "Treasury", min: AdminRole.VIEWER },
  { href: "/admin/payouts", label: "Payouts", min: AdminRole.VIEWER },
  { href: "/admin/abuse", label: "Abuse", min: AdminRole.VIEWER },
  { href: "/admin/hunts", label: "Hunts & caches", min: AdminRole.VIEWER },
  { href: "/admin/survey", label: "Survey", min: AdminRole.OPERATOR },
  { href: "/admin/players", label: "Players", min: AdminRole.VIEWER },
  { href: "/admin/audit", label: "Audit", min: AdminRole.VIEWER },
  { href: "/admin/admins", label: "Admins", min: AdminRole.OWNER },
];

export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await getAdminSession();

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 antialiased">
      <header className="border-b border-slate-800 bg-slate-950/95">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
          <a
            href="/admin"
            className="text-sm font-semibold tracking-wide text-slate-100"
          >
            HUNT OPS
          </a>
          <span className="rounded border border-slate-700 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
            monad · chain 143 · real MON
          </span>

          {session && (
            <nav className="flex flex-wrap items-center gap-1 text-xs">
              {NAV.filter((n) => roleAtLeast(session.role, n.min)).map((n) => (
                <a
                  key={n.href}
                  href={n.href}
                  className="rounded px-2 py-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                >
                  {n.label}
                </a>
              ))}
            </nav>
          )}

          <div className="ml-auto flex items-center gap-2 text-xs">
            {session ? (
              <>
                <span
                  className="font-mono text-slate-400"
                  title={session.walletAddress}
                >
                  {shortAddress(session.walletAddress)}
                </span>
                <span className="rounded border border-slate-700 bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-300">
                  {session.role}
                </span>
                <LogoutButton />
              </>
            ) : (
              <a
                href="/admin/login"
                className="text-slate-400 hover:text-slate-100"
              >
                sign in
              </a>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-4 py-4">{children}</main>
    </div>
  );
}
