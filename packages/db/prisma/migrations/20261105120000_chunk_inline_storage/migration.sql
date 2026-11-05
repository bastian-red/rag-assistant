-- Build step 6: keep a chunk's vector and its full-text vector in the row.
--
-- A chunk row is about 3.4 KB (embedding 2,052 bytes, text ~620, tsv ~710),
-- over Postgres's default 2 KB TOAST threshold, so the toaster moved the
-- embedding out of line (halfvec's default storage is EXTERNAL) and
-- compressed or moved the tsv. Every cosine distance and every ts_rank then
-- read the TOAST table: 34 MB of TOAST against a 12 MB heap, and 27,000
-- buffer reads for one full-text search over 2,500 matches
-- (scripts/retrieval-bench.mjs --explain, 2026-11-05).
--
-- - embedding PLAIN: never compressed (a vector does not compress) and never
--   moved out of line.
-- - tsv MAIN: compressed in the row if it must be, moved out only as a last
--   resort.
-- - toast_tuple_target 8160 (the maximum): the toaster acts only on a row
--   that would not fit a page, not on every row over 2 KB.
--
-- New rows follow these rules; the UPDATE rewrites the existing ones, since
-- an unchanged out-of-line value would otherwise keep its TOAST pointer. It
-- writes the same values back (a halfvec's text form round-trips exactly),
-- and the generated tsv is recomputed from the same text.
ALTER TABLE "chunks" ALTER COLUMN "embedding" SET STORAGE PLAIN;
ALTER TABLE "chunks" ALTER COLUMN "tsv" SET STORAGE MAIN;
ALTER TABLE "chunks" SET (toast_tuple_target = 8160);

UPDATE "chunks" SET "embedding" = "embedding"::text::halfvec(1024), "text" = "text" || '';
