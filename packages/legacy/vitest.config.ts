import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Runs from the repository root or this folder; dependencies (vitest,
// ioredis, @types/node) resolve from the repository's node_modules.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
