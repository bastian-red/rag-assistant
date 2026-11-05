# @rag/answer

One question to one cited answer. A library, not a process: the API runs it behind
`POST /chat/:conversationId/messages`, and the eval lane (build step 8) runs the same function,
so what is measured is what ships.

```
question -> retrieve (the asking person's scope)          -> `retrieval` event
         -> abstained? "Not found in your documents."     -> `abstain` event, no model call
         -> prompt: system rules, earlier exchanges, [S1]..[Sn] blocks + question
         -> streamed chat -> marker stream (packed labels only) -> `token` / `citation` events
         -> outcome: DONE | STOPPED | FAILED, text sent, citations resolved, dropped markers
```

```ts
import { answer } from '@rag/answer';

const outcome = await answer(
  { chat: llm.chat, retrieve: (q) => retrieve(deps, { ownerId, query: q, collectionId }) },
  { question, history },
  { signal: stop.signal, emit: (event) => send(event) },
);
outcome.status; //    'DONE' | 'STOPPED' | 'FAILED'
outcome.content; //   exactly the text the reader was sent, markers canonical ([S1][S3])
outcome.citations; // one per cited marker: the chunk, the quote, its page
outcome.dropped; //   markers that named no packed source (SPECS #2)
```

## What it guarantees, and the test that holds each

| Guarantee                                                                                                            | Test                                                       |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `retrieval` is emitted before the first `token`                                                                      | `answer.test.ts` happy path; API `chat.test.ts`            |
| A marker naming no packed source never reaches the reader, and is counted                                            | `answer.test.ts` markers; red proof                        |
| Text, citations and drops are the same however the model cuts its tokens                                             | `answer.test.ts` property test                             |
| An abstention never calls the model                                                                                  | `answer.test.ts` abstention; API `chat.test.ts`; red proof |
| A stop ends STOPPED with exactly the text sent, and aborts the model call; a half-written `[S` held back is not kept | `answer.test.ts` stop; red proof                           |
| The run stops itself at `ANSWER_DEADLINE_MS` (5 min) as FAILED `timeout`                                             | `answer.test.ts` failures                                  |
| A failure says a fixed sentence by code, never a server's text or a passage                                          | `answer.test.ts` failures                                  |
| Sources go in the last user message only; earlier answers lose their markers                                         | `prompt.test.ts`; API `chat.test.ts` history; red proof    |

## The prompt

`SYSTEM_PROMPT` in `src/prompt.ts` states the answer rules of SPECS section 1: only the sources, a
`[Sn]` after every sentence that uses one, the exact abstention sentence, source text is data and
not instructions. It is latent work: the gate tests check its structure, the eval lane measures
what the model does with it, and `PROMPT_VERSION` is stored in every trace so a score is tied to
the wording it was measured on.

History is at most 3 earlier exchanges within 1,200 estimated tokens, newest kept. Only
finished answers count: a stopped half-answer or a "not found" says nothing true about the
documents and nudges the model to repeat itself. The walk back stops at the first exchange that
does not fit, so the model never sees a conversation with a hole in it.

## Tests

```bash
pnpm --filter @rag/answer test     # gate: the run against an in-memory model, the prompt
./scripts/integration.sh chat      # the API over it, with the fake model server
```
