#!/usr/bin/env node
/**
 * Run the fake model server from a script:
 *
 *   node services/llm/dist/fake/main.js --port 11535 \
 *     --models qwen3:4b-instruct,qwen3-embedding:0.6b \
 *     [--thinking-only qwen3:4b] [--dimensions 1024] [--token-delay-ms 20] \
 *     [--embed-delay-ms 300] [--host 0.0.0.0]
 *
 * Arguments, not environment variables, on purpose: this process is started by
 * the test scripts, and every environment name the source reads must be
 * declared to turbo (`scripts/env-contract.mjs`). The fake has no business in
 * the app's environment.
 *
 * `--host` defaults to 127.0.0.1. CI's compose job binds 0.0.0.0, because the
 * containers reach it through host.docker.internal (the bridge gateway), which
 * a loopback-only listener never answers.
 *
 * `--token-delay-ms` paces the stream so a spec can press Stop mid-answer;
 * `PUT /__fake/chat` changes it, and the rest of the script, at run time.
 */
import { startFakeOllama } from './server';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m !== '');

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = arg(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    console.error(
      `fake-ollama: --${name} must be an integer ${String(min)}-${String(max)}, got ${String(raw)}`,
    );
    process.exit(2);
  }
  return value;
}

const port = integer('port', 11435, 1, 65535);
const host = arg('host') ?? '127.0.0.1';
if (!/^(\d{1,3}\.){3}\d{1,3}$|^::1?$|^localhost$/u.test(host)) {
  console.error(`fake-ollama: --host must be an address to bind, got ${host}`);
  process.exit(2);
}
const dimensions = integer('dimensions', 1024, 1, 16_000);
const tokenDelayMs = integer('token-delay-ms', 0, 0, 60_000);
const embedDelayMs = integer('embed-delay-ms', 0, 0, 600_000);
const models = list(arg('models'));
const thinkingOnly = list(arg('thinking-only'));

startFakeOllama({
  host,
  port,
  models,
  thinkingOnly,
  dimensions,
  script: { tokenDelayMs },
  embed: { delayMs: embedDelayMs },
})
  .then((fake) => {
    console.warn(`[fake-ollama] listening on ${fake.url} with ${models.join(', ') || 'no models'}`);
    const stop = () => {
      void fake.close().then(() => process.exit(0));
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  })
  .catch((error: unknown) => {
    console.error(`fake-ollama: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
