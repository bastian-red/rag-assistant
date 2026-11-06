import { createHash } from 'node:crypto';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  HEAD_BYTES,
  TITLE_CHARS,
  createInspector,
  extensionOf,
  inspect,
  isPdf,
  isUtf8Text,
  sniffInspection,
  sniffType,
} from './sniff';

const text = (s: string) => new TextEncoder().encode(s);
const pdf = text('%PDF-1.4\n1 0 obj\n<< >>\nendobj\n');

describe('sniffType', () => {
  it('accepts each kind when the bytes match the name', () => {
    expect(sniffType('manual.pdf', pdf)).toEqual({ ok: true, mime: 'application/pdf' });
    expect(sniffType('notes.MD', text('# Notes'))).toEqual({ ok: true, mime: 'text/markdown' });
    expect(sniffType('notes.markdown', text('# Notes'))).toEqual({
      ok: true,
      mime: 'text/markdown',
    });
    expect(sniffType('log.txt', text('plain'))).toEqual({ ok: true, mime: 'text/plain' });
  });

  it('refuses a .pdf that is not a PDF', () => {
    expect(sniffType('manual.pdf', text('<html>not a pdf</html>'))).toEqual({
      ok: false,
      reason: 'the file is not a PDF',
    });
  });

  it('refuses a PDF renamed to .md, and binary named .txt', () => {
    expect(sniffType('notes.md', pdf)).toEqual({
      ok: false,
      reason: 'the file is a PDF, not a .md file',
    });
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect(sniffType('photo.txt', png)).toEqual({
      ok: false,
      reason: 'the file is not UTF-8 text',
    });
    // Invalid UTF-8 without a NUL: a Latin-1 "é" on its own.
    expect(sniffType('latin1.txt', Uint8Array.from([0x63, 0x61, 0x66, 0xe9]))).toMatchObject({
      ok: false,
    });
  });

  it('tolerates junk before the PDF header, as readers do', () => {
    const junk = new Uint8Array([...text('x'.repeat(500)), ...pdf]);
    expect(sniffType('scan.pdf', junk)).toMatchObject({ ok: true });
  });

  it('refuses an unknown extension, no extension, and an empty file', () => {
    expect(sniffType('report.docx', text('x'))).toMatchObject({ ok: false });
    expect(sniffType('README', text('x'))).toMatchObject({ ok: false });
    expect(sniffType('.md', text('x'))).toMatchObject({ ok: false });
    expect(sniffType('empty.md', new Uint8Array())).toEqual({
      ok: false,
      reason: 'the file is empty',
    });
  });

  it('accepts a UTF-8 byte-order mark', () => {
    expect(
      sniffType('bom.md', Uint8Array.from([0xef, 0xbb, 0xbf, 0x23, 0x20, 0x41])),
    ).toMatchObject({
      ok: true,
    });
  });
});

describe('extensionOf', () => {
  it('reads the last extension, lower-cased', () => {
    expect(extensionOf('a.b.PDF')).toBe('pdf');
    expect(extensionOf('noext')).toBe('');
  });
});

describe('createInspector (an upload judged as it streams)', () => {
  // Bytes that exercise every branch: text with multi-byte characters (so a
  // cut can land inside one), NULs, invalid UTF-8, a PDF header after junk.
  const piece = fc.oneof(
    fc.string({ unit: 'grapheme', maxLength: 40 }).map((s) => new TextEncoder().encode(s)),
    fc.uint8Array({ maxLength: 40 }),
    fc.constant(new TextEncoder().encode('%PDF-1.7\n')),
    fc.constant(Uint8Array.from([0xe2, 0x82, 0xac])),
  );
  const file = fc.array(piece, { maxLength: 12 }).map((parts) => Buffer.concat(parts));
  const cuts = (length: number) =>
    fc.uniqueArray(fc.integer({ min: 0, max: Math.max(0, length) }), { maxLength: 6 });

  it('reaches the same inspection however the stream is cut', () => {
    fc.assert(
      fc.property(
        file.chain((bytes) => fc.tuple(fc.constant(bytes), cuts(bytes.length))),
        ([bytes, at]) => {
          const inspector = createInspector();
          let from = 0;
          for (const to of [...at].sort((a, b) => a - b).concat(bytes.length)) {
            inspector.push(bytes.subarray(from, to));
            from = to;
          }
          expect(inspector.finish()).toEqual(inspect(bytes));
        },
      ),
    );
  });

  it('judges a streamed file exactly as the whole-buffer checks do', () => {
    fc.assert(
      fc.property(file, fc.constantFrom('a.pdf', 'a.md', 'a.txt'), (bytes, name) => {
        const seen = inspect(bytes);
        expect(seen.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
        expect(seen.bytes).toBe(bytes.length);
        expect(isPdf(seen.head)).toBe(isPdf(bytes));
        expect(!seen.hasNul && seen.utf8).toBe(isUtf8Text(bytes));
        expect(sniffInspection(name, seen)).toEqual(sniffType(name, bytes));
      }),
    );
  });

  it('keeps a bounded head and title window, never the whole file', () => {
    const big = Buffer.alloc(5 * 1024 * 1024, 'a');
    const inspector = createInspector();
    for (let i = 0; i < big.length; i += 65_536) inspector.push(big.subarray(i, i + 65_536));
    const seen = inspector.finish();
    expect(seen.bytes).toBe(big.length);
    expect(seen.head.length).toBe(HEAD_BYTES);
    expect(seen.leadingText.length).toBe(TITLE_CHARS);
  });

  it('drops the text window once the bytes stop being UTF-8', () => {
    const seen = inspect(Buffer.concat([Buffer.from('# Title\n'), Buffer.from([0xff])]));
    expect(seen).toMatchObject({ utf8: false, leadingText: '' });
  });
});
