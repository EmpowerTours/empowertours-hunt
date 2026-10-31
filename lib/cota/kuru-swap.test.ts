import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

vi.mock("./kuru", async (orig) => ({
  ...(await orig<typeof import("./kuru")>()),
  kuruToken: vi.fn(async () => {
    const { KuruUnreachable } = await orig<typeof import("./kuru")>();
    throw new KuruUnreachable("/api/generate-token timed out");
  }),
}));

import { SwapNotStarted, swapMonToAusdViaKuru } from "./kuru-swap";

describe("swapMonToAusdViaKuru before anything is sent", () => {
  it("reports nothingSent when Kuru cannot even issue a token", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const err = await swapMonToAusdViaKuru({
      account,
      monWei: 10n ** 18n,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SwapNotStarted);
    expect((err as SwapNotStarted).nothingSent).toBe(true);
    expect(String((err as Error).message)).toMatch(/no answer from Kuru/);
  });
});
