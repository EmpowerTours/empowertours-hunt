import { redirect } from "next/navigation";
import { SignInPanel } from "@/components/auth/SignInPanel";
import { RadarScope } from "@/components/radar/RadarScope";
import { isCotaHost } from "@/lib/host";

export default async function LandingPage() {
  // cota.* is the trading app, not the hunt game — send its root to Cota.
  if (await isCotaHost()) redirect("/cota");
  return (
    /* -----------------------------------------------------------------------
       The same shell as the hunt screen, and for the same reason.
    
       Measured at 440x773 — an iPhone 17 Pro Max in Safari, which is where it
       was reported — this page was 925px, so the SIGN-IN BUTTON was off the
       bottom of the screen. A landing page whose call to action requires a
       scroll to discover is not a landing page.
    
       So: the scope and the wordmark pinned at the top, the sign-in block
       pinned at the bottom, and the prose that explains the game in the one
       region that scrolls. On a tall phone nothing scrolls at all; on a short
       one the only thing you have to reach for is the explanation, never the
       way in.
    ----------------------------------------------------------------------- */
    <main className="safe-top safe-bottom mx-auto flex h-dvh w-full max-w-md flex-col gap-4 overflow-hidden px-5">
      <div className="flex shrink-0 flex-col items-center gap-4">
        {/* The product, shown rather than described: an idle scope, sweeping.
            Capped against the VIEWPORT as well as the width — at 62vw alone it
            took 223px of a 740px screen to say something decorative. */}
        <div className="w-56 max-w-[min(62vw,20dvh)]" aria-hidden>
          <RadarScope
            band={null}
            rangeMeters={500}
            fix={null}
            spawns={[]}
            now={0}
          />
        </div>

        <div className="text-center">
          <h1 className="text-ink text-5xl leading-none font-bold tracking-tight">
            HUNT
          </h1>
          <p className="text-phosphor mt-2 font-mono text-xs tracking-[0.32em] uppercase">
            EmpowerTours
          </p>
        </div>
      </div>

      {/* The explanation, and the only thing here that scrolls. It is also the
          only thing on the page a player can afford not to read. */}
      <div className="relative min-h-0 flex-1 space-y-4 overflow-y-auto">
        <p className="text-ink-dim text-center text-lg leading-snug text-balance">
          Caches are hidden in the real world. Your phone will not tell you
          where they are — only how warm you are getting.
        </p>

        <ul className="text-ink-dim w-full space-y-2 text-sm">
          <Bullet>
            <span className="text-spawn">Rewards</span> drop near you at random,
            pay real MON, and expire fast. Walk to one before it goes, and it is
            yours.
          </Bullet>
          <Bullet>
            No app to install and no seed phrase. Your phone unlocks a wallet;
            the MON lands in it, and you can check every payout on the explorer.
          </Bullet>
          <Bullet>
            Every claim is checked against GPS accuracy, your clock and how fast
            you moved. The server decides, not the app.
          </Bullet>
        </ul>
      </div>

      <div className="shrink-0 space-y-3 pb-1">
        <p className="text-ink text-center text-base font-semibold">
          No wallet. No seed phrase. Just your phone.
        </p>
        <SignInPanel />
      </div>
    </main>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="border-hull-line flex gap-3 border-l-2 pl-3 leading-snug">
      <span>{children}</span>
    </li>
  );
}
