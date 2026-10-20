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
    // Every refusal writes a log line, so passing tests would print hundreds.
    // A failing test still shows its own output.
    silent: "passed-only",
  },
});
