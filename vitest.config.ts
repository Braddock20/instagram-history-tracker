import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite boots a WASM Postgres, which takes longer than the 10s default.
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
