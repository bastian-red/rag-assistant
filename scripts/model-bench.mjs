#!/usr/bin/env node
/**
 * Time to first token and decode speed of the chat model, on the prompt the
 * app really sends: the system rules and a question over packed sources of
 * the size retrieval packs (`--context-tokens`, default 3,200 estimated).
 *
 *   node scripts/model-bench.mjs                    # 3 runs on the running server
 *   node scripts/model-bench.mjs --runs 5 --context-tokens 1600 --json
 *
 * Measures whatever server answers at OLLAMA_URL, as it is configured: the
 * point is to compare server settings (CPU or iGPU, flash attention, KV
 * cache type) and prompt sizes with numbers, not to pick them by feel.
 *
 * Every run starts with a different nonce as the first characters of the
 * system message. Ollama reuses the KV cache of a prompt prefix it has just
 * seen, so a bench that sent one prompt three times would time the prompt
 * once and the cache twice.
 *
 * Sources come from the seeded corpus (packages/db/prisma/corpus), chunked
 * by @rag/chunker exactly as ingest does and packed in order until the
 * budget, so the prompt has the app's block format and a realistic density.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'services', 'answer', 'package.json'));
const { buildPrompt } = require('./dist/index.js');
const { chunkDocument, estimateTokens } = require('@rag/chunker');
const { createOllama } = require('@rag/llm');
const { formatSource } = require('@rag/shared');

const { values: args } = parseArgs({
  options: {
    runs: { type: 'string', default: '3' },
    'context-tokens': { type: 'string', default: '3200' },
    'max-tokens': { type: 'string', default: '96' },
    label: { type: 'string', default: '' },
    json: { type: 'boolean', default: false },
  },
});
const RUNS = Number(args.runs);
const BUDGET = Number(args['context-tokens']);
const MAX_TOKENS = Number(args['max-tokens']);
const url = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const model = process.env.CHAT_MODEL ?? 'qwen3:4b-instruct';

function corpusFiles(dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? corpusFiles(path) : [path];
    });
}

const sources = [];
let used = 0;
for (const path of corpusFiles(join(ROOT, 'packages', 'db', 'prisma', 'corpus'))) {
  const text = readFileSync(path, 'utf8');
  const { chunks } = chunkDocument({ format: path.endsWith('.txt') ? 'text' : 'markdown', text });
  for (const chunk of chunks) {
    const block = {
      marker: sources.length + 1,
      title: path.split('/').at(-1),
      page: 1,
      text: chunk.text,
    };
    const cost = estimateTokens(formatSource(block));
    if (used + cost > BUDGET) break;
    sources.push(block);
    used += cost;
  }
}

// A bench measures slow settings too, so it waits longer than the app would.
const llm = createOllama({ baseUrl: url, chat: { firstTokenTimeoutMs: 900_000 } });
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

async function once(nonce) {
  const prompt = buildPrompt({
    question: 'When does the boiler warranty end, and what keeps it valid?',
    sources,
    history: [],
  });
  const messages = prompt.messages.map((m, i) =>
    i === 0 ? { ...m, content: `[${nonce}] ${m.content}` } : m,
  );
  let usage = null;
  for await (const event of llm.chat(model, messages, { maxTokens: MAX_TOKENS, temperature: 0 })) {
    if (event.type === 'done') usage = event.usage;
  }
  return { estimated: prompt.tokens, ...usage };
}

// A warm-up loads the model, so no run below pays the load.
await once(randomUUID());
const runs = [];
for (let i = 0; i < RUNS; i += 1) runs.push(await once(randomUUID()));

const promptRate = runs.map((r) => (r.promptTokens / r.promptMs) * 1000);
const decodeRate = runs.map((r) => (r.outputTokens / r.outputMs) * 1000);
const result = {
  label: args.label,
  model,
  sources: sources.length,
  estimatedPromptTokens: runs[0].estimated,
  promptTokens: runs[0].promptTokens,
  firstTokenMs: {
    p50: percentile(
      runs.map((r) => r.firstTokenMs),
      50,
    ),
    max: Math.max(...runs.map((r) => r.firstTokenMs)),
  },
  promptTokensPerS: Number(percentile(promptRate, 50).toFixed(1)),
  decodeTokensPerS: Number(percentile(decodeRate, 50).toFixed(1)),
  loadMs: Math.max(...runs.map((r) => r.loadMs)),
  runs: RUNS,
};
if (args.json) process.stdout.write(`${JSON.stringify(result)}\n`);
else {
  console.log(
    `model-bench ${args.label}: ${String(result.sources)} sources, ${String(result.promptTokens)} prompt tokens (estimated ${String(result.estimatedPromptTokens)})`,
  );
  console.log(
    `  first token p50 ${String(Math.round(result.firstTokenMs.p50))} ms (max ${String(Math.round(result.firstTokenMs.max))})   prompt ${String(result.promptTokensPerS)} tok/s   decode ${String(result.decodeTokensPerS)} tok/s`,
  );
}
