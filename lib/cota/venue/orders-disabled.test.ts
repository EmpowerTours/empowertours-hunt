import { afterEach, describe, expect, it, vi } from "vitest";
import { placeOrder } from "./client";

// The preview environment's guarantee that it cannot trade. If this ever
// opens a socket, a staging copy holding someone's real Perpl key could place
// a real order.
describe("COTA_ORDERS_DISABLED", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("refuses before any socket is opened", async () => {
    vi.stubEnv("COTA_ORDERS_DISABLED", "1");
    const opened = vi.fn();
    vi.stubGlobal("WebSocket", opened);
    await expect(
      placeOrder({} as Parameters<typeof placeOrder>[0]),
    ).rejects.toThrow(/disabled/);
    expect(opened).not.toHaveBeenCalled();
  });
});
