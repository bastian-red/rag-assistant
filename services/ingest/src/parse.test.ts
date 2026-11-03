import { INGEST_FAILURES } from '@rag/shared';
import { describe, expect, it } from 'vitest';

import { makePdf } from '../test/pdf';
import { IngestRefusal } from './errors';
import { parseFile } from './parse';

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(IngestRefusal);
      return (error as IngestRefusal).reason;
    },
  );

describe('parseFile: PDF', () => {
  it('keeps one string per page, in order, with an image-only page as empty', async () => {
    const parsed = await parseFile(
      'application/pdf',
      makePdf(['Page one says hello.', null, 'Page three (with parens).']),
    );
    expect(parsed).toEqual({
      format: 'pdf',
      pages: ['Page one says hello.', '', 'Page three (with parens).'],
    });
  });

  it('refuses a scan (every page image-only) with the words the spec names', async () => {
    expect(await refusal(parseFile('application/pdf', makePdf([null, null])))).toBe(
      'no text layer; OCR not supported',
    );
  });

  it('refuses a damaged PDF as unreadable, not as a crash', async () => {
    const broken = Buffer.from('%PDF-1.4\nthis is not the rest of a PDF\n%%EOF\n', 'latin1');
    expect(await refusal(parseFile('application/pdf', broken))).toBe(INGEST_FAILURES.unreadablePdf);
  });

  it('does not detach the caller’s buffer', async () => {
    const bytes = new Uint8Array(makePdf(['x']));
    await parseFile('application/pdf', bytes);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });
});

describe('parseFile: text', () => {
  it('decodes markdown and text as UTF-8, dropping a byte-order mark', async () => {
    const md = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('# Café')]);
    expect(await parseFile('text/markdown', md)).toEqual({ format: 'markdown', text: '# Café' });
    expect(await parseFile('text/plain', new TextEncoder().encode('plain'))).toEqual({
      format: 'text',
      text: 'plain',
    });
  });

  it('refuses invalid UTF-8, and a file that is only whitespace', async () => {
    expect(await refusal(parseFile('text/plain', Uint8Array.from([0x63, 0xe9])))).toBe(
      INGEST_FAILURES.notUtf8,
    );
    expect(await refusal(parseFile('text/markdown', new TextEncoder().encode(' \n\t\n')))).toBe(
      INGEST_FAILURES.empty,
    );
  });
});
