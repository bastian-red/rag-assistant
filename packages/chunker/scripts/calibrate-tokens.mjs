#!/usr/bin/env node
/**
 * Re-measure the token fixture against the real tokenizer.
 *
 * `estimateTokens` (src/tokens.ts) is a fit, not a tokenizer: the exact qwen3
 * tokenizer is a large dependency, and the chunker and the context packer only
 * need a count that is never far under the truth. This script asks the model
 * server for the true count of every sample (`prompt_eval_count` from
 * /api/embed, minus the 2 special tokens every request carries) and rewrites
 * src/fixtures/token-counts.json. The gate test `tokens.test.ts` then holds the
 * estimator to those numbers. Run it after changing EMBED_MODEL to a model
 * with another tokenizer:
 *
 *   node packages/chunker/scripts/calibrate-tokens.mjs      (OLLAMA_URL, EMBED_MODEL)
 *
 * Periodic lane, not the gate: it needs a real model.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');
const OLLAMA = (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/u, '');
const MODEL = process.env.EMBED_MODEL ?? 'qwen3-embedding:0.6b';

const files = (dir) =>
  readdirSync(dir).flatMap((name) =>
    statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)],
  );

/** Every paragraph of the seed corpus, plus shapes it lacks. */
const samples = [
  ...files(join(ROOT, 'packages', 'db', 'prisma', 'corpus')).flatMap((file) =>
    readFileSync(file, 'utf8')
      .split(/\n\s*\n/u)
      .map((p) => p.trim())
      .filter(Boolean),
  ),
  'const total = items.reduce((sum, item) => sum + item.price * item.qty, 0); // TODO: tax',
  'Invoice 2024-03-17 #A-99812: 1,234.56 EUR; IBAN DE89 3704 0044 0532 0130 00.',
  'La caldera se revisa cada otoño; la garantía cubre siete años desde la instalación.',
  'See https://example.com/docs/v2/install?lang=en#step-3 for the full guide.',
  '| 12 October 2022 | P. Adeyemi | 1.2 bar | 3,400 rpm | 98.6% |',
  'Die Wartung des Heizkessels erfolgt jährlich; Störungscode F22 bedeutet zu niedriger Druck.',
  'ERROR 2024-11-01T21:59:16.839Z cmvydhch30030nxmmo8by1vqx 3d4c0a7d3d535c2213f1c8c2e7c871d3',
  'Ein „Zitat“ — mit Gedankenstrich… und Emoji 🙂 und °C, µg, ±0.5.',
];

async function count(input) {
  const response = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST',
    body: JSON.stringify({ model: MODEL, input: [input] }),
  });
  if (!response.ok) throw new Error(`${OLLAMA}/api/embed answered ${response.status}`);
  return (await response.json()).prompt_eval_count;
}

const overhead = (await count('a')) - 1;
const rows = [];
for (const text of [...new Set(samples)])
  rows.push({ text, tokens: (await count(text)) - overhead });
const out = join(here, '..', 'src', 'fixtures', 'token-counts.json');
writeFileSync(
  out,
  `${JSON.stringify({ model: MODEL, measured: new Date().toISOString().slice(0, 10), overhead, samples: rows }, null, 2)}\n`,
);
console.info(
  `calibrate-tokens: ${rows.length} samples from ${MODEL} (overhead ${overhead}) -> ${out}`,
);
