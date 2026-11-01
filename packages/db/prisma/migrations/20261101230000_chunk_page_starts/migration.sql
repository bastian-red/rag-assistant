-- Where each later page begins inside a chunk, so a citation quoted from the
-- second page of a chunk that spans two opens the viewer on the second page.
-- Shape (from @rag/chunker's Chunk.pageStarts): [{"page": 3, "at": 120}, ...],
-- `at` in code points from the chunk's start, like char_start.
ALTER TABLE "chunks" ADD COLUMN "page_starts" JSONB NOT NULL DEFAULT '[]';

-- A CHECK cannot hold a subquery, and the order of the entries needs one, so
-- the rule lives in an IMMUTABLE function the CHECK calls. Each CASE branch
-- guards the casts after it: SQL does not promise the order of OR operands,
-- and casting a string "page" to numeric would raise instead of refusing.
CREATE FUNCTION "chunk_page_starts_valid"(starts JSONB, page_start INTEGER, page_end INTEGER, span INTEGER)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN starts IS NULL OR jsonb_typeof(starts) <> 'array' THEN false
    WHEN jsonb_array_length(starts) = 0 THEN true
    -- Only a PDF chunk has pages to start.
    WHEN page_start IS NULL OR page_end IS NULL THEN false
    -- Every entry is exactly {"page": <integer>, "at": <integer>}.
    WHEN EXISTS (
      SELECT 1 FROM jsonb_array_elements(starts) AS e(v)
      WHERE CASE
        WHEN jsonb_typeof(e.v) <> 'object' THEN true
        WHEN e.v - 'page' - 'at' <> '{}'::jsonb THEN true
        WHEN jsonb_typeof(e.v -> 'page') IS DISTINCT FROM 'number' THEN true
        WHEN jsonb_typeof(e.v -> 'at') IS DISTINCT FROM 'number' THEN true
        ELSE (e.v ->> 'page')::numeric % 1 <> 0 OR (e.v ->> 'at')::numeric % 1 <> 0
      END
    ) THEN false
    -- Pages rise past page_start and end on page_end; offsets rise strictly
    -- inside the chunk (a page starting at 0 would be page_start itself).
    ELSE NOT EXISTS (
      SELECT 1 FROM (
        SELECT (e.v ->> 'page')::numeric AS page, (e.v ->> 'at')::numeric AS at,
               lag((e.v ->> 'page')::numeric) OVER w AS prev_page,
               lag((e.v ->> 'at')::numeric) OVER w AS prev_at,
               e.i = count(*) OVER () AS last
        FROM jsonb_array_elements(starts) WITH ORDINALITY AS e(v, i)
        WINDOW w AS (ORDER BY e.i)
      ) s
      WHERE s.page <= coalesce(s.prev_page, page_start)
         OR s.at <= coalesce(s.prev_at, 0)
         OR s.at >= span
         OR (s.last AND s.page <> page_end)
    )
  END
$$;

ALTER TABLE "chunks"
  ADD CONSTRAINT "chunks_page_starts_check"
    CHECK ("chunk_page_starts_valid"("page_starts", "page_start", "page_end", "char_end" - "char_start"));
