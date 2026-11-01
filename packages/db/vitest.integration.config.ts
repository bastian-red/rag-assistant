import { defineConfig } from 'vitest/config';

/**
 * The database's own integration lane: the guarantees in the migrations
 * (CHECKs, composite foreign keys, triggers), tried against a real Postgres.
 *
 * Separate from `vitest.config.ts` so the gate lane never needs a database.
 * Run through `./scripts/integration.sh`, which points DATABASE_URL at the
 * disposable rag_it database and applies the migrations first.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
