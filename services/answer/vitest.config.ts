import { defineConfig } from 'vitest/config';

// Gate lane: the prompt and the run, against an in-memory model and a stub
// retrieval. The run against the real API graph is apps/api's integration lane.
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
