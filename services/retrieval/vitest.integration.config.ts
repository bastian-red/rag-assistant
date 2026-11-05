import { defineConfig } from 'vitest/config';

// Integration lane: real Postgres (rag_it) with pgvector, started by
// scripts/integration.sh. Vectors come from the fake's hash embedding,
// in-process, so the ranking is deterministic and needs no model server.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
