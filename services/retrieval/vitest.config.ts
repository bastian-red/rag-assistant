import { defineConfig } from 'vitest/config';

// Gate lane: the pure parts (fusion, packing, the abstain rule, options).
// The SQL against Postgres is the integration lane.
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
