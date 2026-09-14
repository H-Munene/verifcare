import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['node_modules/**', 'dist/**'],
    setupFiles: ['./vitest.setup.ts'],
    // Multiple integration test files (enforcement.integration.test.ts, and HEZ-29's
    // routes/*.integration.test.ts) now share one real Postgres database via TEST_DATABASE_URL.
    // Vitest's default file-level parallelism runs separate test files as concurrent processes
    // against that same database - a real bug this project hit, not a hypothetical: one file's
    // TRUNCATE (in its own beforeEach) wiped rows another file's test had just inserted moments
    // earlier, producing foreign-key violations and even a Postgres deadlock. Test files within
    // this project are few and fast enough that running them sequentially costs little.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
