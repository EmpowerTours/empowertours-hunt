import { NextResponse } from "next/server";
import {
  evmDepositOptions,
  fetchSupportedTokens,
} from "@/lib/cota/aurora-tokens";

// ---------------------------------------------------------------------------
// GET /api/cota/aurora/tokens — what a hunter may safely send.
//
// NOT BEHIND requirePlayer, and that is deliberate. This list is public
// information from Aurora, it carries no key, and it names nobody. Gating it
// would mean the one piece of copy that stops a deposit being stranded could
// fail for a hunter whose session had quietly expired.
//
// CACHED IN MEMORY because the answer changes when Aurora lists a new asset —
// on the order of weeks — while the funding screen is opened on the order of
// seconds. The cache is per-instance and dies with the process, which is the
// right amount of durability for something reconstructible by one fetch.
//
// ON FAILURE THIS RETURNS THE LAST GOOD LIST if it has one, and 503 otherwise.
// It never returns an empty list on an error: [] reads as "Aurora accepts
// nothing", and the screen would then show a hunter no safe assets at all —
// which is either a dead end or, worse, read as permission to improvise.
// ---------------------------------------------------------------------------

const TTL_MS = 30 * 60 * 1000;

interface Cached {
  at: number;
  options: Array<{ chain: string; symbols: string[] }>;
}

/**
 * Held on a container rather than in a bare module variable so the assignment
 * after the await is a property write, which cannot clobber a newer value the
 * way reassigning a captured binding can.
 */
const store: { cached: Cached | null } = { cached: null };

/**
 * Last write wins, deliberately.
 *
 * Two requests racing here both fetched the same upstream list, so whichever
 * lands second is not clobbering anything — it is writing the same answer with
 * a fresher timestamp. Kept in its own function so that is stated rather than
 * inferred from where the assignment happens to sit relative to an await.
 */
function remember(options: Cached["options"]): void {
  store.cached = { at: Date.now(), options };
}

export async function GET() {
  const hit = store.cached;
  if (hit !== null && Date.now() - hit.at < TTL_MS) {
    return NextResponse.json({ options: hit.options, cached: true });
  }
  // Read once, before the await, so the fallback below cannot be a list that
  // another concurrent request replaced while this one was in flight.
  const previous = hit;
  try {
    const options = evmDepositOptions(await fetchSupportedTokens());
    // An empty parse is a failure dressed as success — keep the old list.
    if (options.length === 0) {
      return previous === null
        ? NextResponse.json({ error: "unavailable" }, { status: 503 })
        : NextResponse.json({ options: previous.options, stale: true });
    }
    remember(options);
    return NextResponse.json({ options });
  } catch {
    if (previous !== null) {
      return NextResponse.json({ options: previous.options, stale: true });
    }
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
