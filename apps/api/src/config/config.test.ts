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
    RATE_LIMIT_UPLOAD: '10',
    RATE_LIMIT_CHAT: '20',
    UPLOAD_DIR: '/srv/rag/uploads',
    INGEST_URL: 'http://localhost:4500/',
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

describe('the upload settings', () => {
  it('reads the upload directory and the worker’s URL', () => {
    const config = loadConfig(env());
    expect(config.uploadDir).toBe('/srv/rag/uploads');
    expect(config.ingestUrl).toBe('http://localhost:4500');
    expect(config.rateLimitUpload).toBe(10);
  });

  it('refuses a relative upload directory, which would name two folders', () => {
    expect(() => loadConfig(env({ UPLOAD_DIR: '.data/uploads' }))).toThrow(
      /UPLOAD_DIR: must be an absolute path/u,
    );
  });
});

describe('the chat settings', () => {
  it('reads the chat budget, and an absent or empty threshold as the measured default', () => {
    const config = loadConfig(env());
    expect(config.rateLimitChat).toBe(20);
    expect(config.minSimilarity).toBeNull();
    expect(loadConfig(env({ RETRIEVAL_MIN_SIMILARITY: ' ' })).minSimilarity).toBeNull();
  });

  it('reads a threshold override as a number in [-1, 1]', () => {
    expect(loadConfig(env({ RETRIEVAL_MIN_SIMILARITY: '0.12' })).minSimilarity).toBe(0.12);
    expect(loadConfig(env({ RETRIEVAL_MIN_SIMILARITY: '-0.5' })).minSimilarity).toBe(-0.5);
    expect(loadConfig(env({ RETRIEVAL_MIN_SIMILARITY: '.3' })).minSimilarity).toBe(0.3);
  });

  it('refuses a threshold that is not a similarity, by name', () => {
    for (const bad of ['1.5', '-2', 'abc', '0.4.3', '1e-1']) {
      expect(() => loadConfig(env({ RETRIEVAL_MIN_SIMILARITY: bad }))).toThrow(
        /RETRIEVAL_MIN_SIMILARITY/u,
      );
    }
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

  it('refuses a chat budget at or above the global one', () => {
    expect(() => assertConsistent(loadConfig(env({ RATE_LIMIT_CHAT: '240' })))).toThrow(
      /RATE_LIMIT_CHAT \(240\) must be below RATE_LIMIT_GLOBAL \(240\)/u,
    );
  });

  it('refuses an upload budget at or above the global one', () => {
    expect(() => assertConsistent(loadConfig(env({ RATE_LIMIT_UPLOAD: '240' })))).toThrow(
      /RATE_LIMIT_UPLOAD \(240\) must be below RATE_LIMIT_GLOBAL \(240\)/u,
    );
  });
});
