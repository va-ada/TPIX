import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    fileParallelism: false,
    testTimeout: 15000,
    env: {
      // CRITICAL: tests destructively reset tables. Use a separate DB file so
      // production state in data/tpix.sqlite is never touched.
      TPIX_DB_FILE: "data/tpix.test.sqlite",
      // Don't push commits to GitHub during tests
      TPIX_GIT_DISABLE_PUSH: "1",
    },
  },
});
