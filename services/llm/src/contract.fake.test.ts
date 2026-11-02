/**
 * The llm contract against the fake, in the gate lane. The same suite runs
 * against a real Ollama in `contract.real.test.ts`.
 */
import { afterAll, beforeAll } from 'vitest';

import { llmContract } from '../test/contract';
import { startFakeOllama, type FakeOllama } from './fake/server';

let fake: FakeOllama;
beforeAll(async () => {
  fake = await startFakeOllama({
    models: ['qwen3:4b-instruct', 'qwen3-embedding:0.6b', 'qwen3:4b'],
    thinkingOnly: ['qwen3:4b'],
    // Paced, as a real model is, so a stop lands mid-answer.
    script: { tokenDelayMs: 5 },
  });
});
afterAll(() => fake.close());

llmContract('the fake', 5000, () => ({
  baseUrl: fake.url,
  chatModel: 'qwen3:4b-instruct',
  embedModel: 'qwen3-embedding:0.6b',
  thinkingOnlyModel: 'qwen3:4b',
  lastChat: () => fake.chats.at(-1),
  embedCalls: () => fake.embeds.length,
}));
