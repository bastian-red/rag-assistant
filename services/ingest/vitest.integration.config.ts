import { defineConfig } from 'vitest/config';

// Integration lane: real Postgres (rag_it), Redis db 1 and the fake model
// server, started by scripts/integration.sh. One file at a time: the files
// share the database and the queue.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
