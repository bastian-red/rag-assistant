# @rag/evals: the periodic eval lane

What the assistant is judged on: a pinned corpus, 64 questions with gold spans, the real open-weight
models, and the code the API runs. Not a copy of it: the eval calls `ingestDocument` from
`@rag/ingest`, `retrieve` from `@rag/retrieval` and `answer` from `@rag/answer`. A threshold that
misses fails the run.

```bash
./scripts/ollama-setup.sh        # the real models (iGPU on where Ollama supports it)
pnpm evals --label baseline      # retrieval, answers, judge: about 35-50 min on the reference laptop
pnpm evals --phases retrieval,sweep --chunks 400:60,250:40   # retrieval only: about 5 min
pnpm evals --limit 8 --no-fail --no-write                    # a quick look, two questions per kind
pnpm evals --baseline evals/reports/2026-11-07-baseline.json # this run beside a stored one
tail -f /tmp/rag-eval/progress.log                           # percent, rate and ETA per phase
```

`scripts/evals.sh` builds, refuses the fake model server (its digest says what it is), and runs
against its own database (`rag_eval`, same Postgres) and upload folder (`.data/eval-uploads`), so
it never touches `pnpm dev`. Ingested libraries persist and are reused while the corpus bytes, the
expected status and the embedding model are unchanged. Not in CI: a runner has no model server.

## What is measured, and how

| Score                      | How                                                                                                                                                                                       | Threshold         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Ingest outcomes            | each file's status against the manifest (`scanned-notice.pdf` must be refused)                                                                                                            | all match         |
| recall@6, MRR              | gold spans (quotes located in the stored text, code points) against the chunks of each ranked source; abstention off so ranking alone is scored                                           | >= 0.90, >= 0.70  |
| Hybrid vs one list         | the same questions in `vector` and `text` mode                                                                                                                                            | hybrid >= each    |
| Abstain threshold          | chosen on the dev split from hybrid best similarities, scored on test (`calibrate`)                                                                                                       | reported          |
| Correct / false abstention | an answer is an abstention when retrieval abstained or the model replied "Not found in your documents"                                                                                    | >= 0.90 / <= 0.05 |
| Citation coverage          | `coverage()` from `@rag/citations`: claims of four or more words carrying a marker                                                                                                        | >= 0.85           |
| Citation precision         | each (claim, marker) pair: on a gold span counts by construction, otherwise the judge reads that one passage; the judged share is corrected for the judge's errors on chunk-length labels | >= 0.95           |
| Faithfulness               | the judge reads each answer's claims against the sources it cites; the rate is corrected for the judge's measured errors (Rogan-Gladen)                                                   | >= 0.90           |
| Hostile documents          | no answer to a `hos-*` question contains a forbidden string from the injected instruction                                                                                                 | none              |

The split is fixed by the question id (first byte of its sha256, even = dev), so a threshold is
never chosen on the questions it is scored on.

## The judge is measured before it is believed

`judge/labels.jsonl` holds 50 claims over corpus passages, 25 supported and 25 not, each label
following from how the claim was built (verbatim or paraphrase: supported; a changed number, a
negation, a swapped name or an outside fact: not). Thirty quote a sentence or two; twenty quote a
whole paragraph of 900 to 1,700 characters, the size of a source the judge reads in a run, with
the supported fact buried in it and often stated approximately ("some 27 m"). Every run scores the
judge on all of them and on the long ones apart, and fails below TPR 0.80 or TNR 0.80 on either.
The long-passage measurement corrects faithfulness and the judged part of citation precision
(Rogan-Gladen). A reply that is not exactly the requested JSON is a failed judgement, counted,
never read as a pass.

Judge v1 copied its two-verdict example on one-claim requests (4 of 30 unreadable); v2 states the
count. One label (`l25`) quoted a passage that never named its subject, and the judge was right to
reject it; the passage was widened. The long labels were added after the judge scored 1.0 on the
short ones and still rejected supported claims inside real sources (`pc-gatun`: "some 27 m (87 ft)
above sea level"); their facts are ones no eval question asks about, so they cannot be fitted to
the claims they correct.

## Files

| Path                   | What                                                                    |
| ---------------------- | ----------------------------------------------------------------------- |
| `corpus/manifest.json` | 12 documents: sha256, bytes, licence, source revision, expected status  |
| `corpus/SOURCES.md`    | licences and attribution; `corpus/build.py` regenerates `corpus/files/` |
| `questions.jsonl`      | 42 answerable, 8 multi-hop, 10 unanswerable, 4 hostile                  |
| `judge/labels.jsonl`   | the judge's 50 labels (`isLong`: 20 at chunk length)                    |
| `src/run.ts`           | the phases; `src/metrics.ts` the arithmetic; `src/report.ts` the checks |
| `reports/`             | one JSON (the record) and one markdown (the reading) per run            |

The gate tests (`pnpm --filter @rag/evals test`, no model, no database) hold the arithmetic, the
question and label files, and that every gold quote and label passage occurs exactly once in the
text ingest stores.

## Scores

See the latest report in `reports/`; the README's eval section quotes the baseline.
