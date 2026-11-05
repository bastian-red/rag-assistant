import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config';

const BASE = {
  DATABASE_URL: 'postgresql://rag:rag@localhost:5445/rag',
  REDIS_URL: 'redis://localhost:6391',
  OLLAMA_URL: 'http://localhost:11434/',
  EMBED_MODEL: 'qwen3-embedding:0.6b',
  UPLOAD_DIR: '/srv/uploads',
};

describe('loadConfig', () => {
  it('fills the defaults and trims the model server URL', () => {
    expect(loadConfig(BASE)).toMatchObject({
      port: 4500,
      concurrency: 1,
      lockMs: 30_000,
      sweepMs: 60_000,
      ollamaUrl: 'http://localhost:11434',
      uploadDir: '/srv/uploads',
    });
  });

  it('treats a blank optional value as unset, as .env.example ships them', () => {
    expect(loadConfig({ ...BASE, INGEST_PORT: '', INGEST_CONCURRENCY: ' ' }).port).toBe(4500);
  });

  it('refuses a relative upload directory, naming the variable', () => {
    expect(() => loadConfig({ ...BASE, UPLOAD_DIR: '.data/uploads' })).toThrow(
      /UPLOAD_DIR: must be an absolute path/u,
    );
  });

  it('reports every failing name at once', () => {
    let error: unknown;
    try {
      loadConfig({ INGEST_LOCK_MS: '10' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    for (const name of [
      'DATABASE_URL',
      'REDIS_URL',
      'OLLAMA_URL',
      'EMBED_MODEL',
      'UPLOAD_DIR',
      'INGEST_LOCK_MS',
    ])
      expect(message).toContain(name);
  });
});
