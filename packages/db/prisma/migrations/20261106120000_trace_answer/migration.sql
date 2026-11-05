-- Build step 7: what a trace keeps about the answer, not only the search.
--
-- SPECS #2: a marker naming no packed source is dropped AND counted in the
-- trace. `dropped` holds each one as written ({raw, labels}).
-- `abstain_reason` says why the chat model was not called; null when it was.
-- `best_similarity` is the number the abstain rule compared, so a verdict
-- can be checked against the threshold that reached it.
-- `details` holds the rest of the run (options used, timings, model usage,
-- how many earlier exchanges the prompt carried): read by people auditing
-- an answer, never filtered on, so one object rather than columns.

ALTER TABLE "retrieval_traces"
  ADD COLUMN "abstain_reason" TEXT,
  ADD COLUMN "best_similarity" DOUBLE PRECISION,
  ADD COLUMN "dropped" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "details" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "retrieval_traces"
  -- The two reasons in @rag/retrieval's AbstainReason.
  ADD CONSTRAINT "retrieval_traces_abstain_reason_check"
    CHECK ("abstain_reason" IS NULL OR "abstain_reason" IN ('no_candidates', 'below_threshold')),
  ADD CONSTRAINT "retrieval_traces_best_similarity_check"
    CHECK ("best_similarity" IS NULL OR "best_similarity" BETWEEN -1 AND 1),
  ADD CONSTRAINT "retrieval_traces_dropped_check" CHECK (jsonb_typeof("dropped") = 'array'),
  ADD CONSTRAINT "retrieval_traces_details_check" CHECK (jsonb_typeof("details") = 'object');
