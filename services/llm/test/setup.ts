/**
 * Property-test budget. The gate lane runs a modest number of cases per
 * property so the suite stays fast; `FC_RUNS=2000 pnpm --filter @rag/llm
 * test` runs a deep search before a change to the stripper ships.
 */
import fc from 'fast-check';

fc.configureGlobal({ numRuns: Number(process.env.FC_RUNS ?? 60) });
