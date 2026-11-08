#!/usr/bin/env node
/**
 * Is the model server up, are CHAT_MODEL and EMBED_MODEL pulled, and can each
 * do its job (a thinking-only chat build cannot)?
 *
 * Run by scripts/dev.sh before turbo starts, so a missing model is one
 * sentence with the command that fixes it, not a failed question later. It
 * asks through the built `@rag/llm` client, the same code `/health` uses.
 *
 *   node scripts/check-models.mjs                (OLLAMA_URL, CHAT_MODEL, EMBED_MODEL)
 *   node scripts/check-models.mjs --embed-only   the embedding model alone (a
 *                                                retrieval-only eval never chats)
 *
 * 0 = ready. 1 = unreachable, a model missing or unfit, with the fix. 2 = misconfigured.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { createOllama, missingModels, modelProblems } = createRequire(import.meta.url)(
  join(root, 'services', 'llm', 'dist', 'index.js'),
);

const url = process.env.OLLAMA_URL;
const chat = process.env.CHAT_MODEL;
const embed = process.env.EMBED_MODEL;
if (!url || !chat || !embed) {
  console.error('check-models: OLLAMA_URL, CHAT_MODEL and EMBED_MODEL must all be set (.env).');
  process.exit(2);
}

const embedOnly = process.argv.includes('--embed-only');

try {
  const ollama = createOllama({ baseUrl: url, timeoutMs: 3000 });
  const status = embedOnly
    ? {
        chat: { model: chat, present: true, problem: null },
        embed: await ollama.checkModel('embed', embed),
      }
    : await ollama.checkModels({ chat, embed });
  const missing = missingModels(status);
  if (missing.length > 0) {
    console.error(`The model server at ${url} does not have: ${missing.join(', ')}. Pull them:`);
    for (const model of missing) console.error(`  ollama pull ${model}`);
    console.error(
      `or run ./scripts/ollama-setup.sh${embedOnly ? ' --embed-only' : ''}, which installs Ollama and pulls ${embedOnly ? 'it' : 'both'}.`,
    );
    process.exit(1);
  }
  const problems = modelProblems(status);
  if (problems.length > 0) {
    console.error(`A configured model cannot do its job:`);
    for (const problem of problems) console.error(`  ${problem}`);
    console.error('Set CHAT_MODEL / EMBED_MODEL in .env (see .env.example) and pull it.');
    process.exit(1);
  }
  console.log(
    embedOnly
      ? `models: ${embed} is ready at ${url}`
      : `models: ${chat} and ${embed} are ready at ${url}`,
  );
} catch (error) {
  console.error(`The model server is not reachable at ${url} (${error.message}). Start it:`);
  console.error('  ollama serve        (installed by ./scripts/ollama-setup.sh)');
  console.error('or, to work on everything but answer quality, the fake model server:');
  console.error(
    `  pnpm ollama:fake --port ${new URL(url).port || '11434'} --models ${chat},${embed}`,
  );
  process.exit(1);
}
