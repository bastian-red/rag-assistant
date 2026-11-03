export * from './ollama';
export { createLlm, type LlmConfig } from './client';
export { ThinkStripper } from './think';
export {
  startFakeOllama,
  CONTEXT_LENGTH_REFUSAL,
  type FakeOllama,
  type FakeOllamaOptions,
  type FakeEmbedScript,
} from './fake/server';
export { hashEmbedding } from './fake/embedding';
export { scriptedAnswer, streamPieces } from './fake/answer';
