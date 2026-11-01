import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PAGE_BREAK, assemblePages, normalise, pageAt } from './normalise';
import { messyText } from '../test/arbitraries';

const ch = (code: number) => String.fromCodePoint(code);
const BOM = ch(0xfeff);
const NBSP = ch(0x00a0);
const ZWSP = ch(0x200b);
const SOFT_HYPHEN = ch(0x00ad);
const BELL = ch(0x07);

describe('normalise', () => {
  it('turns every line ending into a line feed', () => {
    expect(normalise('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  it('drops a byte-order mark, invisible characters and control characters', () => {
    expect(normalise(`${BOM}co${SOFT_HYPHEN}op${ZWSP}era${BELL}tive`)).toBe('cooperative');
  });

  it('turns tabs and Unicode spaces into plain spaces, keeping runs inside a line', () => {
    expect(normalise(`a\tb${NBSP}c   d`)).toBe('a b c   d');
  });

  it('composes to NFC', () => {
    const decomposed = `cafe${ch(0x0301)}`;
    expect(normalise(decomposed)).toBe(`caf${ch(0x00e9)}`);
    expect(Array.from(normalise(decomposed))).toHaveLength(4);
  });

  it('strips trailing spaces, collapses blank runs and trims blank edges', () => {
    expect(normalise('\n\n  one  \n\n\n\n two \n\n')).toBe('  one\n\n two');
  });

  it('composes only after removing invisibles, so a second pass changes nothing', () => {
    const raw = `e${ZWSP}${ch(0x0301)}`;
    expect(normalise(raw)).toBe(ch(0x00e9));
    expect(normalise(normalise(raw))).toBe(normalise(raw));
  });

  it('is idempotent', () => {
    fc.assert(fc.property(messyText, (raw) => normalise(normalise(raw)) === normalise(raw)));
  });

  it('leaves nothing it promises to remove', () => {
    fc.assert(
      fc.property(messyText, (raw) => {
        const text = normalise(raw);
        return (
          !/[\r\t\u00A0\u00AD\u200B-\u200D\u2060\uFEFF]/u.test(text) &&
          // eslint-disable-next-line no-control-regex
          !/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/u.test(text) &&
          !/ +$/mu.test(text) &&
          !/\n{3}/u.test(text) &&
          !/^\n|\n$/u.test(text)
        );
      }),
    );
  });

  it('keeps every visible character, in order', () => {
    fc.assert(
      fc.property(messyText, (raw) => {
        const visible = (s: string) =>
          s
            // eslint-disable-next-line no-control-regex
            .replace(/[\s\u00AD\u200B-\u200D\u2060\uFEFF\u0000-\u001F\u007F-\u009F]/gu, '')
            .normalize('NFC');
        return visible(normalise(raw)) === visible(raw);
      }),
    );
  });
});

describe('assemblePages', () => {
  it('joins pages with a blank line and records where each sits', () => {
    const { text, pages } = assemblePages(['One.\r\n', '', '  ', 'Four.']);
    expect(text).toBe(`One.${PAGE_BREAK}Four.`);
    expect(pages).toEqual([
      { page: 1, start: 0, end: 4 },
      { page: 2, start: 4, end: 4 },
      { page: 3, start: 4, end: 4 },
      { page: 4, start: 6, end: 11 },
    ]);
  });

  it('gives every page its own text, exactly', () => {
    fc.assert(
      fc.property(fc.array(messyText, { maxLength: 6 }), (raw) => {
        const { text, pages } = assemblePages(raw);
        return pages.every((span, i) => text.slice(span.start, span.end) === normalise(raw[i]!));
      }),
    );
  });
});

describe('pageAt', () => {
  const { pages } = assemblePages(['First page.', '', 'Third page.']);

  it('answers the page of a character, skipping empty pages', () => {
    const leading = assemblePages(['', '', 'Only text.']).pages;
    expect(pageAt(leading, 0)).toBe(3);
    expect(pageAt(pages, 0)).toBe(1);
    expect(pageAt(pages, 10)).toBe(1);
    // "Third page." starts after "First page." (11) and the break (2).
    expect(pageAt(pages, 13)).toBe(3);
    expect(pageAt(pages, 23)).toBe(3);
  });

  it('is null for text without pages', () => {
    expect(pageAt([], 0)).toBeNull();
  });

  it('agrees with a linear scan on every non-space character', () => {
    fc.assert(
      fc.property(fc.array(messyText, { maxLength: 6 }), (raw) => {
        const { text, pages } = assemblePages(raw);
        for (let at = 0; at < text.length; at += 1) {
          if (/\s/u.test(text[at]!)) continue;
          const owner = pages.find((p) => p.start <= at && at < p.end)!;
          if (pageAt(pages, at) !== owner.page) return false;
        }
        return true;
      }),
    );
  });
});
