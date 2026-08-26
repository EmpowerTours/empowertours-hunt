// Environment for the route modules under test.
//
// Imported for its side effects, and imported FIRST — several modules read
// these at import time, so setting them inside a beforeAll would be too late.
// Vitest's `setupFiles` would also work; this keeps the ordering visible in the
// file that depends on it.
//
// Every secret here is a throwaway that exists only to clear a length check.
// Nothing in this directory should ever read a real one: an integration suite
// that needs production credentials is a suite nobody will run.

// NODE_ENV is typed read-only by @types/node. It matters here because
// `defaultNonceStore()` refuses the in-memory store when it is "production",
// so the assignment is real, not cosmetic.
(process.env as Record<string, string>).NODE_ENV ??= "test";

// Only the mera cookie provider. Leaving Privy enabled would have every
// unauthenticated request reach out to Privy's API and fail slowly.
process.env.AUTH_PROVIDERS = "mera";

process.env.AUTH_SESSION_SECRET ??= "integration-session-secret-".padEnd(48, "x");
process.env.ADMIN_SESSION_SECRET ??= "integration-admin-secret-".padEnd(48, "x");
process.env.SPAWN_SEED_SECRET ??= "integration-spawn-seed-".padEnd(48, "x");
process.env.HINT_GRID_SECRET ??= "integration-hint-grid-".padEnd(48, "x");
process.env.CRON_SECRET ??= "integration-cron-secret-".padEnd(32, "x");

// No Upstash. lib/ratelimit falls back to its bounded in-memory bucket and
// lib/auth/eip712 falls back to MemoryNonceStore, which is single-process —
// exactly what this suite is.
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

export const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. These tests need a real Postgres:\n\n" +
      "  docker run -d --name hunt-pg -e POSTGRES_PASSWORD=hunt \\\n" +
      "    -e POSTGRES_USER=hunt -e POSTGRES_DB=hunt -p 5434:5432 postgres:16-alpine\n" +
      '  export DATABASE_URL="postgresql://hunt:hunt@localhost:5434/hunt"\n' +
      "  npx prisma migrate deploy\n" +
      "  npm run test:integration\n",
  );
}
