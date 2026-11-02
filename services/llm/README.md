# @rag/llm

The only code in this repo that talks to the model server (Ollama). Everything else uses the
`LlmClient` contract in `@rag/shared`:

```ts
import { createLlm } from '@rag/llm';

const llm = createLlm({ baseUrl: OLLAMA_URL, chatModel: CHAT_MODEL, embedModel: EMBED_MODEL });

await llm.models(); // { chat: { model, present, problem }, embed: { ... } }
await llm.embed(['a passage', 'another']); // number[][], 1024 dimensions each
for await (const event of llm.chat(messages, { signal })) {
  if (event.type === 'token')
    write(event.text); // visible text, in order
  else record(event.usage); // exactly one `done`, last
}
```

Every failure is an `LlmError` with a stable `code` (see `LLM_ERROR_CODES`).

## Files

| File               | What it holds                                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ollama.ts`    | The HTTP client: `/api/tags` + `/api/show` (readiness), streamed `/api/chat`, batched `/api/embed`, the two clocks                                              |
| `src/client.ts`    | `createLlm`: the contract with the configured models bound                                                                                                      |
| `src/think.ts`     | The `<think>` stripper, split-invariant                                                                                                                         |
| `src/ndjson.ts`    | NDJSON lines from a body; cancels the body when the reader leaves, which closes the request                                                                     |
| `src/errors.ts`    | `LlmError`, `OllamaUnreachable`, HTTP status to code                                                                                                            |
| `src/fake/`        | The Ollama-compatible fake: hashed embeddings, scripted cited answers, abort records, control routes; `main.ts` runs it from a script (arguments in its header) |
| `test/contract.ts` | The contract suite, run against the fake (`src/contract.fake.test.ts`) and the real server (`src/contract.real.test.ts`)                                        |

## Tests

```bash
pnpm --filter @rag/llm test        # gate lane: unit tests + the contract suite on the fake
pnpm llm:contract:real             # the same contract suite on the Ollama in .env (local only)
FC_RUNS=2000 pnpm --filter @rag/llm test   # deep property search for the stripper and the fake
```

The real run is skipped in CI on purpose: a runner has no model server, and a cold load of the 4B
chat model took 65 s on a CPU before the first token.
