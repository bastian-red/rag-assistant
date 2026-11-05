import { describe, expect, it } from 'vitest';

import { cachedSpace } from './retrieve';
import {
  QWEN3_QUERY_INSTRUCTION,
  queryInstructionFor,
  RETRIEVAL_DEFAULTS,
  retrievalOptions,
} from './options';

describe('retrievalOptions', () => {
  it('ships the plan’s numbers (top 40 + 40, k 6, RRF 60) and the measured abstain point', () => {
    expect(RETRIEVAL_DEFAULTS).toMatchObject({
      vectorK: 40,
      textK: 40,
      k: 6,
      rrfK: 60,
      minSimilarity: 0.43,
    });
    // The midpoint of the 2026-11-05 gap: 0.338 best unanswerable, 0.526 worst answerable.
    expect((0.338 + 0.526) / 2).toBeCloseTo(0.432, 3);
  });

  it('applies overrides and refuses a value out of range', () => {
    expect(retrievalOptions({ k: 3 }).k).toBe(3);
    expect(() => retrievalOptions({ k: 0 })).toThrow();
    expect(() => retrievalOptions({ mode: 'other' as 'text' })).toThrow();
  });

  it('writes the query instruction in the shape Qwen3-Embedding reads, ending where the query begins', () => {
    expect(QWEN3_QUERY_INSTRUCTION.startsWith('Instruct: ')).toBe(true);
    expect(QWEN3_QUERY_INSTRUCTION.endsWith('\nQuery: ')).toBe(true);
  });

  it('picks the instruction by the space’s model: Qwen3 gets its own, another model none', () => {
    expect(queryInstructionFor('qwen3-embedding:0.6b@ac6da0dfba84')).toBe(QWEN3_QUERY_INSTRUCTION);
    expect(queryInstructionFor('nomic-embed-text:latest@0a109f422b47')).toBeNull();
    expect(RETRIEVAL_DEFAULTS.queryInstruction).toBe('auto');
  });
});

describe('cachedSpace', () => {
  it('asks once per ttl, again after it, and never caches a failure', async () => {
    let calls = 0;
    let fail = false;
    let clock = 0;
    const read = async () => {
      calls += 1;
      if (fail) throw new Error('down');
      return `m@${String(calls).padStart(12, '0')}`;
    };
    const space = cachedSpace(read, 1_000, () => clock);
    expect(await space()).toBe('m@000000000001');
    clock = 999;
    expect(await space()).toBe('m@000000000001');
    clock = 1_000;
    fail = true;
    await expect(space()).rejects.toThrow('down');
    fail = false;
    expect(await space()).toBe('m@000000000003');
    expect(calls).toBe(3);
  });
});
