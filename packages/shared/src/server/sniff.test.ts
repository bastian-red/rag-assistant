import { describe, expect, it } from 'vitest';

import { extensionOf, sniffType } from './sniff';

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
