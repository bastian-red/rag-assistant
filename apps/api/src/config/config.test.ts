import { describe, expect, it } from 'vitest';

import { BootError, assertConsistent } from './boot';
import { ConfigError, loadConfig } from './config';

/** A complete environment, so every test changes exactly one thing. */
function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    APP_VERSION: '0.1.0',
    API_PORT: '4600',
    DATABASE_URL: 'postgresql://rag:pw@localhost:5445/rag',
    REDIS_URL: 'redis://localhost:6391',
    AUTH_SECRET: 'x'.repeat(32),
    OLLAMA_URL: 'http://localhost:11434',
    CHAT_MODEL: 'qwen3:4b',
    EMBED_MODEL: 'qwen3-embedding:0.6b',
    RATE_LIMIT_GLOBAL: '240',
    RATE_LIMIT_AUTH: '5',
    ...overrides,
  };
}

describe('loadConfig', () => {
  it('reads the documented environment', () => {
    const config = loadConfig(env());
    expect(config.port).toBe(4600);
    expect(config.chatModel).toBe('qwen3:4b');
    expect(config.embedModel).toBe('qwen3-embedding:0.6b');
  });

  it('prefers PORT over API_PORT, and falls through an empty PORT', () => {
    expect(loadConfig(env({ PORT: '4200' })).port).toBe(4200);
    expect(loadConfig(env({ PORT: '' })).port).toBe(4600);
  });

  it('names every missing variable in one message', () => {
    expect(() => loadConfig(env({ DATABASE_URL: undefined, AUTH_SECRET: undefined }))).toThrow(
      /DATABASE_URL[\s\S]*AUTH_SECRET/u,
    );
  });

  it('refuses a short secret', () => {
    expect(() => loadConfig(env({ AUTH_SECRET: 'short' }))).toThrow(ConfigError);
  });

  it('refuses a service URL with no protocol, which new URL() would have parsed', () => {
    expect(() => loadConfig(env({ OLLAMA_URL: 'localhost:11434' }))).toThrow(/OLLAMA_URL/u);
  });

  it('strips a trailing slash from service URLs', () => {
    expect(loadConfig(env({ OLLAMA_URL: 'http://ollama:11434/' })).ollamaUrl).toBe(
      'http://ollama:11434',
    );
  });

  it('refuses a model name that is not an Ollama reference, naming the variable', () => {
    expect(() => loadConfig(env({ CHAT_MODEL: 'qwen3 4b' }))).toThrow(/CHAT_MODEL/u);
    expect(() => loadConfig(env({ EMBED_MODEL: '' }))).toThrow(/EMBED_MODEL/u);
  });
});

describe('assertConsistent', () => {
  it('accepts the documented defaults', () => {
    expect(() => assertConsistent(loadConfig(env()))).not.toThrow();
  });

  it('refuses an auth budget at or above the global one', () => {
    expect(() => assertConsistent(loadConfig(env({ RATE_LIMIT_AUTH: '240' })))).toThrow(
      /credential-stuffing/u,
    );
    expect(() => assertConsistent(loadConfig(env({ RATE_LIMIT_AUTH: '300' })))).toThrow(BootError);
  });
});
