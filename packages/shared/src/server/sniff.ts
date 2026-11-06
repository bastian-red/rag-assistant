/**
 * What a file is, from its bytes, not its name.
 *
 * The name and the declared type say what the uploader CLAIMS; the bytes say
 * what it is. A file is accepted only when the two agree:
 *
 * - `.pdf` must start with `%PDF-` (a PDF may carry up to 1 KB of junk before
 *   the header, which readers tolerate; so does this);
 * - `.md` / `.markdown` / `.txt` must be valid UTF-8 with no NUL byte, which
 *   no text file has and every binary format does within its first few bytes.
 *
 * A UTF-8 byte-order mark is accepted (editors on Windows write one) and the
 * readers strip it.
 *
 * An upload is judged as it streams to disk (`createInspector`), so the API
 * never holds a whole file: it keeps the first `HEAD_BYTES` (the PDF header
 * window), the first `TITLE_CHARS` of text (where a title is looked for), a
 * running sha256, and two flags. `sniffType(name, bytes)` is the same judgement
 * over a buffer, and a property test holds the two equal however the stream is
 * cut.
 */
import { createHash } from 'node:crypto';

import type { AcceptedType } from '../contracts/ingest';

export type Sniffed =
  | { readonly ok: true; readonly mime: AcceptedType }
  | { readonly ok: false; readonly reason: string };

const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');
const PDF_HEADER_WINDOW = 1024;

const BY_EXTENSION: Readonly<Record<string, AcceptedType>> = {
  pdf: 'application/pdf',
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
};

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot <= 0 ? '' : filename.slice(dot + 1).toLowerCase();
}

export function isPdf(bytes: Uint8Array): boolean {
  return (
    Buffer.from(
      bytes.buffer,
      bytes.byteOffset,
      Math.min(bytes.length, PDF_HEADER_WINDOW + 5),
    ).indexOf(PDF_MAGIC) !== -1
  );
}

export function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Bytes kept from the start of a stream: enough for the PDF header window. */
export const HEAD_BYTES = PDF_HEADER_WINDOW + PDF_MAGIC.length;
/** Text kept from the start of a stream, for `documentTitle`. */
export const TITLE_CHARS = 16_384;

/** What a whole file comes to, gathered a piece at a time. */
export interface Inspection {
  readonly bytes: number;
  readonly sha256: string;
  readonly head: Uint8Array;
  readonly hasNul: boolean;
  readonly utf8: boolean;
  /** The first TITLE_CHARS of the text when it is valid UTF-8, else ''. */
  readonly leadingText: string;
}

export interface Inspector {
  push(chunk: Uint8Array): void;
  finish(): Inspection;
}

export function createInspector(): Inspector {
  const hash = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const head = new Uint8Array(HEAD_BYTES);
  let headLength = 0;
  let bytes = 0;
  let hasNul = false;
  let utf8 = true;
  let leadingText = '';
  const decode = (chunk: Uint8Array | undefined, stream: boolean) => {
    if (!utf8) return;
    try {
      const text = decoder.decode(chunk, { stream });
      if (leadingText.length < TITLE_CHARS)
        leadingText += text.slice(0, TITLE_CHARS - leadingText.length);
    } catch {
      utf8 = false;
      leadingText = '';
    }
  };
  return {
    push(chunk) {
      hash.update(chunk);
      if (headLength < HEAD_BYTES) {
        const take = chunk.subarray(0, HEAD_BYTES - headLength);
        head.set(take, headLength);
        headLength += take.length;
      }
      if (!hasNul && chunk.includes(0)) hasNul = true;
      bytes += chunk.length;
      decode(chunk, true);
    },
    finish() {
      decode(undefined, false);
      return {
        bytes,
        sha256: hash.digest('hex'),
        head: head.slice(0, headLength),
        hasNul,
        utf8,
        leadingText,
      };
    },
  };
}

export function inspect(bytes: Uint8Array): Inspection {
  const inspector = createInspector();
  inspector.push(bytes);
  return inspector.finish();
}

/** The judgement over a whole file's inspection. */
export function sniffInspection(filename: string, file: Inspection): Sniffed {
  const extension = extensionOf(filename);
  const claimed = BY_EXTENSION[extension];
  if (claimed === undefined) {
    return { ok: false, reason: 'only .pdf, .md, .markdown and .txt files can be uploaded' };
  }
  if (file.bytes === 0) return { ok: false, reason: 'the file is empty' };
  if (claimed === 'application/pdf') {
    return isPdf(file.head)
      ? { ok: true, mime: claimed }
      : { ok: false, reason: 'the file is not a PDF' };
  }
  if (isPdf(file.head)) return { ok: false, reason: `the file is a PDF, not a .${extension} file` };
  return !file.hasNul && file.utf8
    ? { ok: true, mime: claimed }
    : { ok: false, reason: 'the file is not UTF-8 text' };
}

export function sniffType(filename: string, bytes: Uint8Array): Sniffed {
  return sniffInspection(filename, inspect(bytes));
}
