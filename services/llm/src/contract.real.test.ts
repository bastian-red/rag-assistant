/**
 * The llm contract against a real Ollama. Skipped unless LLM_CONTRACT_URL is
 * set, which `pnpm llm:contract:real` does from `.env`.
 *
 * Skipped in CI on purpose: a GitHub runner has no GPU, no pulled models
 * (2.5 GB + 0.6 GB per run), and a cold 4B load took 65 s on this machine
 * before the first token. The fake lane runs the same suite on every commit;
 * this run is what keeps the fake honest, before a model or client change ships.
 */
import { describe } from 'vitest';

import { llmContract } from '../test/contract';

const url = process.env.LLM_CONTRACT_URL;

if (url === undefined || url === '') {
  describe.skip('the llm contract against a real Ollama (set LLM_CONTRACT_URL, or run pnpm llm:contract:real; CI has no model server, the fake runs this suite instead)', () =>
    undefined);
} else {
  const chatModel = process.env.CHAT_MODEL ?? 'qwen3:4b-instruct';
  const embedModel = process.env.EMBED_MODEL ?? 'qwen3-embedding:0.6b';
  const thinkingOnlyModel = process.env.LLM_CONTRACT_THINKING_MODEL;
  // A cold load of the chat model, then a short answer, on a CPU.
  llmContract(`a real Ollama (${chatModel})`, 300_000, () => ({
    baseUrl: url,
    chatModel,
    embedModel,
    ...(thinkingOnlyModel ? { thinkingOnlyModel } : {}),
  }));
}
