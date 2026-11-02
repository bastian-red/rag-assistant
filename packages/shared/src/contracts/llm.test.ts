import { describe, expect, it } from 'vitest';

import {
  chatEventSchema,
  chatMessageSchema,
  modelRefSchema,
  modelStatusSchema,
  normaliseModel,
} from './llm';

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

describe('the chat contract', () => {
  const usage = {
    promptTokens: 13,
    outputTokens: 6,
    stopReason: 'stop',
    thinkingDropped: 0,
    firstTokenMs: null,
    totalMs: 10,
    loadMs: 0,
    promptMs: 1,
    outputMs: 9,
  };

  it('accepts a token and a done event', () => {
    expect(chatEventSchema.parse({ type: 'token', text: ' there' })).toEqual({
      type: 'token',
      text: ' there',
    });
    expect(chatEventSchema.parse({ type: 'done', usage }).type).toBe('done');
  });

  it('refuses an empty token, an unknown field and an unknown role', () => {
    expect(chatEventSchema.safeParse({ type: 'token', text: '' }).success).toBe(false);
    expect(chatEventSchema.safeParse({ type: 'token', text: 'a', thinking: 'b' }).success).toBe(
      false,
    );
    expect(chatMessageSchema.safeParse({ role: 'tool', content: 'x' }).success).toBe(false);
  });

  it('reports a pulled model that cannot do its job with a reason', () => {
    const check = { model: 'qwen3:4b', present: true, problem: 'thinking-only build' };
    expect(modelStatusSchema.parse({ chat: check, embed: { ...check, problem: null } })).toEqual({
      chat: check,
      embed: { ...check, problem: null },
    });
    expect(
      modelStatusSchema.safeParse({ chat: { model: 'x', present: true }, embed: check }).success,
    ).toBe(false);
  });
});
