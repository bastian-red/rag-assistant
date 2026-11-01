#!/usr/bin/env node
/**
 * Run the fake model server from a script:
 *
 *   node services/llm/dist/fake/main.js --port 11435 --models qwen3:4b,qwen3-embedding:0.6b
 *
 * Arguments, not environment variables, on purpose: this process is started by
 * the test scripts, and every environment name the source reads must be
 * declared to turbo (`scripts/env-contract.mjs`). The fake has no business in
 * the app's environment.
 */
import { startFakeOllama } from './server';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const port = Number(arg('port') ?? '11435');
const models = (arg('models') ?? '')
  .split(',')
  .map((m) => m.trim())
  .filter((m) => m !== '');

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`fake-ollama: --port must be 1-65535, got ${String(arg('port'))}`);
  process.exit(2);
}

startFakeOllama({ port, models })
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
