import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    // Most files start an in-memory Postgres (PGlite) per test, which takes about
    // two seconds alone and far longer when every file starts one at once. These
    // limits stop a slow machine from failing setup that is merely queued.
    hookTimeout: 60_000,
    maxWorkers: 8,
  },
});
