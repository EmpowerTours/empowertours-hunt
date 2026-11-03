import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryNonceStore, defaultNonceStore } from "./eip712";

// Which nonce store a production build gets without Redis. The memory store
// cannot stop a replay across instances, so it is refused in production except
// for an explicitly single-instance, explicitly non-production deployment.
describe("defaultNonceStore without Redis", () => {
  afterEach(() => vi.unstubAllEnvs());

  function env(vars: Record<string, string | undefined>) {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("NODE_ENV", "production");
    for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v as string);
  }

  it("refuses in production", () => {
    env({ RAILWAY_ENVIRONMENT_NAME: "production" });
    expect(() => defaultNonceStore()).toThrow(/required in production/);
  });

  it("refuses the flag on the production environment", () => {
    env({ RAILWAY_ENVIRONMENT_NAME: "production", HUNT_SINGLE_INSTANCE_NONCES: "1" });
    expect(() => defaultNonceStore()).toThrow(/required in production/);
  });

  it("refuses the flag when the environment is unnamed", () => {
    env({ RAILWAY_ENVIRONMENT_NAME: "", HUNT_SINGLE_INSTANCE_NONCES: "1" });
    expect(() => defaultNonceStore()).toThrow(/required in production/);
  });

  it("refuses a non-production environment that did not opt in", () => {
    env({ RAILWAY_ENVIRONMENT_NAME: "cotas-preview" });
    expect(() => defaultNonceStore()).toThrow(/required in production/);
  });

  it("allows the opted-in preview", () => {
    env({ RAILWAY_ENVIRONMENT_NAME: "cotas-preview", HUNT_SINGLE_INSTANCE_NONCES: "1" });
    expect(defaultNonceStore()).toBeInstanceOf(MemoryNonceStore);
  });
});
