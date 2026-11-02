/**
 * The `services/llm` contract (SPECS section 3) over a real or fake Ollama:
 * `chat(messages, {signal})`, `embed(texts)`, `models()`, with the configured
 * model names bound once, so no caller passes a model name around.
 */
import type { LlmClient } from '@rag/shared';

import { createOllama, type Ollama, type OllamaOptions } from './ollama';

export interface LlmConfig extends OllamaOptions {
  /** `CHAT_MODEL`. */
  readonly chatModel: string;
  /** `EMBED_MODEL`. */
  readonly embedModel: string;
}

export function createLlm(config: LlmConfig, ollama: Ollama = createOllama(config)): LlmClient {
  return {
    chat: (messages, options) => ollama.chat(config.chatModel, messages, options),
    embed: (texts, options) => ollama.embed(config.embedModel, texts, options),
    models: () => ollama.checkModels({ chat: config.chatModel, embed: config.embedModel }),
  };
}
