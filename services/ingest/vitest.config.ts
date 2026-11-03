import { defineConfig } from 'vitest/config';

// Gate lane: pure units only (config, parsing, failure classification). The
// pipeline against Postgres, Redis and the fake model is the integration lane.
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
