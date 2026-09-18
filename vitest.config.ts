import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // components/ holds pure helpers the screens depend on — fixQuality decides
    // whether a claim is worth attempting, secondsLeft decides what a waiting
    // player is told. Both were unreachable by the runner until now.
    include: ["lib/**/*.test.ts", "components/**/*.test.ts"],
  },
});
