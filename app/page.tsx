import { SignInPanel } from "@/components/auth/SignInPanel";
import { RadarScope } from "@/components/radar/RadarScope";

export default function LandingPage() {
  return (
    <main className="safe-top safe-bottom mx-auto flex min-h-dvh w-full max-w-md flex-col justify-between gap-8 px-5">
      <div className="flex flex-1 flex-col items-center justify-center gap-7 pt-6">
        {/* The product, shown rather than described: an idle scope, sweeping. */}
        <div className="w-56 max-w-[62vw]" aria-hidden>
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
          <p className="text-phosphor mt-3 font-mono text-xs tracking-[0.32em] uppercase">
            EmpowerTours
          </p>
          <p className="text-ink-dim mt-5 text-lg leading-snug text-balance">
            Caches are hidden in the real world. Your phone will not tell you
            where they are — only how warm you are getting.
          </p>
        </div>

        <ul className="text-ink-dim w-full space-y-2 text-sm">
          <Bullet>
            Walk to a cache and claim it. Finds pay{" "}
            <span className="text-phosphor">TURBO credit</span> — a discount on
            the cohort subscription, not withdrawable cash.
          </Bullet>
          <Bullet>
            <span className="text-spawn">Spawns</span> drop near you at random,
            pay real MON, and expire fast. Those you can see on the scope.
          </Bullet>
          <Bullet>
            Every claim is checked against GPS accuracy, your clock and how fast
            you moved. The server decides, not the app.
          </Bullet>
        </ul>
      </div>

      <div className="space-y-4 pb-2">
        <p className="text-ink text-center text-base font-semibold">
          No wallet. No seed phrase. Just Face&nbsp;ID.
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
