/**
 * The pinned corpus: `corpus/manifest.json` names every file with its
 * sha256, licence and source, and what ingest must make of it (READY, or
 * FAILED for the scan).
 *
 * `documentText` is the text exactly as ingest stores it: the same parser
 * (@rag/ingest `parseFile`) and the same normalisation (`chunkDocument`'s
 * `text`). Gold spans are located in that text, and chunk offsets index
 * into it, so "does this chunk hold the gold span" is a comparison of two
 * code-point ranges in one string, never a fuzzy match.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { chunkDocument } from '@rag/chunker';
import { IngestRefusal, parseFile } from '@rag/ingest';
import { ACCEPTED_TYPES, type AcceptedType } from '@rag/shared';
import { z } from 'zod';

export const EVALS_ROOT = resolve(__dirname, '..');
export const CORPUS_DIR = join(EVALS_ROOT, 'corpus');

const documentSchema = z
  .object({
    file: z.string().regex(/^[a-z0-9.-]+$/u),
    title: z.string().min(1),
    mime: z.enum(ACCEPTED_TYPES),
    license: z.string().min(1),
    source: z.string().min(1),
    retrieved: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    bytes: z.number().int().positive(),
    expect: z.enum(['READY', 'FAILED']),
  })
  .strict();

export const manifestSchema = z
  .object({ version: z.literal(1), documents: z.array(documentSchema).min(1) })
  .strict();

export type CorpusDocument = z.infer<typeof documentSchema>;

export function loadManifest(dir = CORPUS_DIR): CorpusDocument[] {
  const manifest = manifestSchema.parse(
    JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')),
  );
  const files = new Set<string>();
  for (const doc of manifest.documents) {
    if (files.has(doc.file)) throw new Error(`manifest: ${doc.file} is listed twice`);
    files.add(doc.file);
  }
  return manifest.documents;
}

/** The file's bytes, refused when they are not the bytes the manifest pinned. */
export function corpusBytes(doc: CorpusDocument, dir = CORPUS_DIR): Buffer {
  const bytes = readFileSync(join(dir, 'files', doc.file));
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== doc.sha256) {
    throw new Error(`corpus: ${doc.file} is not the pinned file (sha256 ${sha})`);
  }
  return bytes;
}

/** The normalised text ingest stores for this document, or null when ingest refuses it. */
export async function documentText(doc: CorpusDocument, dir = CORPUS_DIR): Promise<string | null> {
  let parsed;
  try {
    parsed = await parseFile(doc.mime as AcceptedType, corpusBytes(doc, dir));
  } catch (error) {
    if (error instanceof IngestRefusal) return null;
    throw error;
  }
  const input =
    parsed.format === 'pdf'
      ? { format: 'pdf' as const, pages: parsed.pages }
      : { format: parsed.format, text: parsed.text };
  return chunkDocument(input).text;
}
