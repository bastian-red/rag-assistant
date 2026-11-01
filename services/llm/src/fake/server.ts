/**
 * An Ollama-compatible fake, for every lane that must run with no model:
 * integration, E2E, dev-smoke and CI.
 *
 * It speaks the same HTTP shapes the real server does, so `createOllama` is
 * exercised unchanged against it; nothing in the app knows it is talking to a
 * fake. Build step 1 serves `/api/version` and `/api/tags`; build step 4 adds
 * `/api/embed` (deterministic hashed vectors) and `/api/chat` (a scripted,
 * streamed answer that cites the sources it was given).
 *
 * Every request is recorded, so a test can assert what reached the model
 * server (and, from step 4, that an aborted stream was really aborted).
 *
 * `PUT /__fake/models` with `{"models": [...]}` replaces what `/api/tags`
 * lists. It exists so an E2E spec, which cannot reach into this process, can
 * make a model "disappear" and watch `/health` and `/status` say so. The real
 * Ollama has no such route, and nothing in the app calls it.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeOllamaOptions {
  /** 0 picks a free port. */
  readonly port?: number;
  readonly host?: string;
  /** What `/api/tags` lists, as Ollama would name them. */
  readonly models: readonly string[];
}

export interface FakeOllama {
  readonly url: string;
  readonly requests: readonly { method: string; path: string }[];
  /** Replace what `/api/tags` lists (the in-process form of `PUT /__fake/models`). */
  setModels(models: readonly string[]): void;
  close(): Promise<void>;
}

const VERSION = '0.0.0-fake';

export async function startFakeOllama(options: FakeOllamaOptions): Promise<FakeOllama> {
  const requests: { method: string; path: string }[] = [];
  let models: readonly string[] = [...options.models];

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? '/', 'http://fake').pathname;
    requests.push({ method: request.method ?? 'GET', path });

    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };

    if (request.method === 'GET' && path === '/api/version') {
      return json(200, { version: VERSION });
    }
    if (request.method === 'GET' && path === '/api/tags') {
      return json(200, {
        models: models.map((name) => ({ name, model: name, size: 0, digest: 'fake' })),
      });
    }
    if (request.method === 'PUT' && path === '/__fake/models') {
      let raw = '';
      request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
      request.on('end', () => {
        try {
          const body = JSON.parse(raw) as { models?: unknown };
          if (!Array.isArray(body.models) || !body.models.every((m) => typeof m === 'string')) {
            return json(400, { error: 'models must be an array of strings' });
          }
          models = [...(body.models as string[])];
          return json(200, { models });
        } catch {
          return json(400, { error: 'body must be JSON' });
        }
      });
      return;
    }
    // Ollama answers an unknown route with a plain-text 404.
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('404 page not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://${address.address}:${String(address.port)}`,
    requests,
    setModels: (next) => {
      models = [...next];
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
