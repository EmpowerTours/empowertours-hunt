import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { PUBLIC_HUNT_SELECT, isListable } from "@/lib/hunt/publicHunt";
import { HuntList } from "./HuntList";

export const metadata: Metadata = { title: "Hunts" };
export const dynamic = "force-dynamic";

/**
 * The list is a detour when there is nothing to choose between.
 *
 * Somebody arriving from a campaign link wants the scope, not a menu with one
 * item on it — a tap that always has the same answer is a tap that should not
 * exist. So a single listable hunt redirects straight to its radar, and the
 * list appears only once there is a real choice to make, which is what happens
 * as soon as Sembradores start planting hunts in other cities.
 *
 * Redirected on the SERVER rather than in an effect, so nobody sees a list
 * flash up and vanish.
 *
 * Listability comes from the same helper the API uses. Two definitions of
 * "worth showing" would eventually disagree, and the way it would surface is a
 * redirect into a hunt the list refuses to display.
 */
export default async function HuntsPage() {
  const rows = await prisma.hunt.findMany({
    where: { active: true },
    orderBy: [{ startsAt: "asc" }, { name: "asc" }],
    take: 3,
    select: PUBLIC_HUNT_SELECT,
  });

  const now = new Date();
  const listable = rows.filter((row) => isListable(row, now));

  if (listable.length === 1) {
    redirect(`/hunt/${listable[0].id}`);
  }

  return (
    <main className="safe-top safe-bottom mx-auto flex w-full max-w-md flex-col gap-4 px-4 pb-6">
      <header className="flex items-center justify-between gap-3 pt-2">
        <h1 className="text-ink text-2xl font-bold">Hunts</h1>
        <Link
          href="/hunt/wallet"
          className="border-hull-line text-ink-dim flex min-h-11 items-center rounded-xl border px-3 font-mono text-xs tracking-widest uppercase"
        >
          Wallet
        </Link>
      </header>

      <HuntList />
    </main>
  );
}
