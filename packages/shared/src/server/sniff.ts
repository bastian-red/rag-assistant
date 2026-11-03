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
 */
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

export function sniffType(filename: string, bytes: Uint8Array): Sniffed {
  const extension = extensionOf(filename);
  const claimed = BY_EXTENSION[extension];
  if (claimed === undefined) {
    return { ok: false, reason: 'only .pdf, .md, .markdown and .txt files can be uploaded' };
  }
  if (bytes.length === 0) return { ok: false, reason: 'the file is empty' };
  if (claimed === 'application/pdf') {
    return isPdf(bytes)
      ? { ok: true, mime: claimed }
      : { ok: false, reason: 'the file is not a PDF' };
  }
  if (isPdf(bytes)) return { ok: false, reason: `the file is a PDF, not a .${extension} file` };
  return isUtf8Text(bytes)
    ? { ok: true, mime: claimed }
    : { ok: false, reason: 'the file is not UTF-8 text' };
}
