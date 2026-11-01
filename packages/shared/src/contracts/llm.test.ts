import { describe, expect, it } from 'vitest';

import { modelRefSchema, normaliseModel } from './llm';

describe('normaliseModel', () => {
  it('adds :latest to an untagged name, as Ollama resolves it', () => {
    expect(normaliseModel('nomic-embed-text')).toBe('nomic-embed-text:latest');
  });

  it('keeps an explicit tag and lowercases', () => {
    expect(normaliseModel('Qwen3:4B')).toBe('qwen3:4b');
  });

  it('reads the tag after the last slash, so a registry port is not a tag', () => {
    expect(normaliseModel('registry.local:5000/ns/qwen3')).toBe(
      'registry.local:5000/ns/qwen3:latest',
    );
    expect(normaliseModel('hf.co/org/model:q4')).toBe('hf.co/org/model:q4');
  });
});

describe('modelRefSchema', () => {
  it('accepts the configured defaults', () => {
    expect(modelRefSchema.parse('qwen3:4b')).toBe('qwen3:4b');
    expect(modelRefSchema.parse('qwen3-embedding:0.6b')).toBe('qwen3-embedding:0.6b');
  });

  it('refuses a blank name or one with spaces', () => {
    expect(modelRefSchema.safeParse('').success).toBe(false);
    expect(modelRefSchema.safeParse('qwen3 4b').success).toBe(false);
  });
});
