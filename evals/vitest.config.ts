import { defineConfig } from 'vitest/config';

// Gate lane: the scoring, the question and label files, the corpus manifest.
// No model and no database; `pnpm evals` is the lane that has both. The
// corpus is parsed once in globalSetup, not once per file.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globalSetup: ['./vitest.setup.ts'],
  },
});
