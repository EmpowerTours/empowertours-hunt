import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Integration tests. Separate from vitest.config.ts because these need a real
// Postgres — the whole point is to exercise what a pure function cannot:
// migrations applying, Json columns round-tripping, and conditional UPDATEs
// under genuine concurrency.
//
//   docker run -d --name hunt-pg -e POSTGRES_PASSWORD=hunt -e POSTGRES_USER=hunt \
//     -e POSTGRES_DB=hunt -p 5434:5432 postgres:16-alpine
//   export DATABASE_URL="postgresql://hunt:hunt@localhost:5434/hunt"
//   npx prisma migrate deploy
//   npm run test:integration
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.itest.ts"],
    // One database, shared state. Parallel files would race on the same rows.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
