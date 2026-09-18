import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { LinkButton, Note, Panel } from "@/components/ui/primitives";

// ---------------------------------------------------------------------------
// Where the Android app comes from.
//
// It is served from here rather than a store, and that deserves a straight
// explanation rather than a download button on its own. Installing an app from
// outside Google Play is exactly the move a crypto scam asks you to make, and
// this app holds a wallet. Telling somebody to do it without saying so would be
// teaching the habit that gets people robbed.
//
// So the page does three things a bare link cannot:
//
//   * It publishes the SHA-256 of the exact file being served, HASHED FROM THAT
//     FILE at render time. Not a constant someone pasted in — a constant can
//     drift from the artifact, and a hash that does not match what you are
//     holding is worse than no hash, because it reads as verified.
//   * It says this is the only place the app is published, so anything else
//     claiming to be it is not.
//   * It says plainly what still does not work, because a first-run failure
//     that nobody warned you about is indistinguishable from a compromise.
// ---------------------------------------------------------------------------

export const metadata = {
  title: "Get the Android app — EmpowerTours",
  description:
    "Install EmpowerTours on Android. One app for the hunt and for Cota, with the SHA-256 of the file published so you can check what you installed.",
};

const APK_PATH = "/EmpowerTours.apk";

/**
 * Hash and size of the file actually being served.
 *
 * Computed from `public/EmpowerTours.apk` rather than stored beside it, so the
 * page cannot advertise a checksum for a build it is not serving. Memoised at
 * module scope: the file is immutable for the life of a deploy, and re-reading
 * five megabytes per request to arrive at the same answer would be silly.
 */
let cached: Promise<{ sha256: string; bytes: number }> | null = null;

function apkFacts(): Promise<{ sha256: string; bytes: number }> {
  cached ??= readFile(path.join(process.cwd(), "public", "EmpowerTours.apk"))
    .then((buf) => ({
      sha256: createHash("sha256").update(buf).digest("hex"),
      bytes: buf.byteLength,
    }))
    .catch(() => {
      // Reset so a later request can try again — a one-off read failure should
      // not poison the page for the life of the process.
      cached = null;
      throw new Error("apk missing");
    });
  return cached;
}

export default async function DownloadPage() {
  let facts: { sha256: string; bytes: number } | null = null;
  try {
    facts = await apkFacts();
  } catch {
    facts = null;
  }

  return (
    <main className="safe-top safe-bottom mx-auto flex w-full max-w-md flex-col gap-5 px-5 py-8">
      <header className="text-center">
        <h1 className="text-ink text-3xl font-bold tracking-tight">
          EmpowerTours for Android
        </h1>
        <p className="text-ink-dim mt-3 leading-snug text-balance">
          One app. Walk to a cache and get paid in MON, or trade perpetuals on
          Perpl with a leash you set. Same passkey, same wallet, either door.
        </p>
      </header>

      {facts === null ? (
        <Note tone="stop" title="No build published right now">
          The download is not on this server. Rather than hand you a broken link
          — or worse, a file we cannot vouch for — this says so. Try again
          later.
        </Note>
      ) : (
        <>
          <a
            href={APK_PATH}
            download
            className="bg-phosphor text-hull flex min-h-14 w-full items-center justify-center rounded-2xl border-2 border-transparent px-5 text-lg font-semibold tracking-wide"
          >
            DOWNLOAD THE APK
          </a>
          <p className="text-ink-faint text-center font-mono text-xs">
            {(facts.bytes / 1_048_576).toFixed(1)} MB · xyz.empowertours.app
          </p>

          <Panel>
            <h2 className="text-ink font-mono text-xs tracking-[0.18em] uppercase">
              Check what you installed
            </h2>
            <p className="text-ink-dim mt-2 text-sm leading-snug">
              This is the SHA-256 of the file this page is serving, hashed from
              the file itself. If what you downloaded does not match, it is not
              ours — delete it.
            </p>
            <code className="text-phosphor mt-3 block break-all font-mono text-[11px] leading-relaxed">
              {facts.sha256}
            </code>
            <p className="text-ink-faint mt-3 font-mono text-[11px] leading-relaxed">
              sha256sum EmpowerTours.apk
            </p>
          </Panel>
        </>
      )}

      <Note tone="warn" title="This is the only place we publish it">
        We are not on Google Play yet. Anything else offering an EmpowerTours
        app — a link in a message, another site, a different store — is not us.
        The app holds a wallet, so that distinction is worth more than the
        convenience of installing from wherever.
      </Note>

      <Panel>
        <h2 className="text-ink font-mono text-xs tracking-[0.18em] uppercase">
          Installing it
        </h2>
        <ol className="text-ink-dim mt-3 list-decimal space-y-2 pl-5 text-sm leading-snug">
          <li>Download the file above.</li>
          <li>
            Open it. Android will refuse the first time and offer a settings
            screen — that refusal is the system working, not a fault.
          </li>
          <li>
            Allow this once for your browser, then open the file again. Turn the
            permission back off afterwards if you like; the app keeps working.
          </li>
        </ol>
        <p className="text-ink-faint mt-3 text-sm leading-snug">
          Android 7 or newer. Signing in needs a phone with a screen lock and
          Google Password Manager, because your wallet lives in a passkey rather
          than a seed phrase.
        </p>
      </Panel>

      <Note title="What does not work yet">
        There is no iPhone build. Everything runs in a mobile browser in the
        meantime — the app is a convenience, not a requirement, and your wallet
        is the same one either way.
      </Note>

      <div className="space-y-3 pt-2">
        {/* Put this where someone who just failed to sign in will find it. The
            page is the substitute for a USB cable: it measures what the device
            can do and says so, so a bug report from three hours away is still
            actionable. */}
        <LinkButton href="/diag">Sign-in not working? Run diagnostics</LinkButton>
        <LinkButton href="/cota">Open Cota in this browser</LinkButton>
        <LinkButton href="/hunt">Browse hunts</LinkButton>
      </div>
    </main>
  );
}
