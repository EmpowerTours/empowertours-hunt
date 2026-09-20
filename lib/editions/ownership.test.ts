import { afterEach, describe, expect, it, vi } from "vitest";
import { unexplainedLicences } from "./ownership";

/* ---------------------------------------------------------------------------
   The arithmetic is the whole point of this module, so it is what is tested.

   `licensesHeld` is tier-blind, which makes it wrong for excluding and right
   for warning — but only once our own claims are subtracted. Getting that
   subtraction wrong would either warn a hunter about a licence they bought
   here (noise that suppresses the standard-to-collector upgrade) or fail to
   warn about one they bought elsewhere.
--------------------------------------------------------------------------- */

const REG = "0x42EbcD44C2295702130f0A641633c691bA5f9480" as const;
const OWNER = "0x0000000000000000000000000000000000000abc" as const;

function stubHeld(value: bigint | Error) {
  vi.doMock("viem", async () => {
    const actual = await vi.importActual<typeof import("viem")>("viem");
    return {
      ...actual,
      createPublicClient: () => ({
        readContract: () =>
          value instanceof Error
            ? Promise.reject(value)
            : Promise.resolve(value),
      }),
    };
  });
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("viem");
});

async function call(held: bigint | Error, knownCount: number) {
  stubHeld(held);
  const { unexplainedLicences: fn } = await import("./ownership");
  return fn({ registry: REG, owner: OWNER, masterId: 10n, knownCount });
}

describe("unexplainedLicences", () => {
  it("is zero when our records explain everything they hold", async () => {
    // Bought the standard through hunt. Offered the collector later, this
    // must NOT warn — that upgrade is the funnel.
    expect(await call(1n, 1)).toBe(0);
  });

  it("counts a licence they got somewhere else", async () => {
    // Bought at the venue, never through hunt.
    expect(await call(1n, 0)).toBe(1);
  });

  it("is zero when they hold nothing at all", async () => {
    expect(await call(0n, 0)).toBe(0);
  });

  it("counts only the surplus when they hold some of each", async () => {
    expect(await call(3n, 1)).toBe(2);
  });

  // A PENDING claim is written before the licence exists, and a hunter may
  // transfer one away. Either makes our count exceed the chain's, and a
  // negative would render as a warning about owing licences.
  it("clamps at zero when our count exceeds the chain's", async () => {
    expect(await call(0n, 2)).toBe(0);
  });

  // Null is "could not ask", which the caller must not read as "none".
  it("returns null rather than zero when the chain cannot be reached", async () => {
    expect(await call(new Error("rpc down"), 0)).toBeNull();
  });
});
