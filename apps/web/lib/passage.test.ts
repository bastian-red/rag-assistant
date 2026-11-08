import { describe, expect, it } from 'vitest';

import { highlight, offsetParam, originalHref, pageAt, passageHref } from './passage';

describe('highlight', () => {
  it('cuts the text around the span', () => {
    expect(highlight('Alpha. Beta. Gamma.', 7, 12)).toEqual({
      before: 'Alpha. ',
      quote: 'Beta.',
      after: ' Gamma.',
    });
  });

  it('counts code points, so an astral character before the quote does not shift it', () => {
    // "🐝" is one code point and two UTF-16 units: a UTF-16 slice at 2..6 would give "Bees".
    const text = '🐝 Bees fly.';
    expect(Array.from(text).length).toBe(11);
    expect(text.length).toBe(12);
    expect(highlight(text, 2, 6)?.quote).toBe('Bees');
  });

  it('refuses a span that does not fit, rather than marking the wrong text', () => {
    expect(highlight('short', 2, 9)).toBeNull();
    expect(highlight('short', 3, 3)).toBeNull();
    expect(highlight('short', -1, 2)).toBeNull();
    expect(highlight('short', null, 2)).toBeNull();
  });
});

describe('pageAt', () => {
  const chunk = {
    pageStart: 3,
    pageStarts: [
      { page: 4, at: 120 },
      { page: 5, at: 300 },
    ],
  };

  it('is the first page before the first later page starts', () => {
    expect(pageAt(chunk, 0)).toBe(3);
    expect(pageAt(chunk, 119)).toBe(3);
  });

  it('is the page that starts at or before the offset', () => {
    expect(pageAt(chunk, 120)).toBe(4);
    expect(pageAt(chunk, 299)).toBe(4);
    expect(pageAt(chunk, 300)).toBe(5);
  });

  it('is null for a document without pages', () => {
    expect(pageAt({ pageStart: null, pageStarts: [] }, 10)).toBeNull();
  });
});

describe('offsetParam', () => {
  it('accepts a plain non-negative integer only', () => {
    expect(offsetParam('0')).toBe(0);
    expect(offsetParam('42')).toBe(42);
    expect(offsetParam('-1')).toBeNull();
    expect(offsetParam('4.5')).toBeNull();
    expect(offsetParam('1e3')).toBeNull();
    expect(offsetParam(['1', '2'])).toBeNull();
    expect(offsetParam(undefined)).toBeNull();
  });
});

describe('links', () => {
  it('carries the span to the viewer when it is known', () => {
    expect(passageHref({ documentId: 'd', chunkId: 'c' })).toBe('/documents/d/passages/c');
    expect(passageHref({ documentId: 'd', chunkId: 'c', from: 0, to: 9 })).toBe(
      '/documents/d/passages/c?from=0&to=9',
    );
  });

  it('opens the original at a page, or at its start without one', () => {
    expect(originalHref('d', 2)).toBe('/api/documents/d/file#page=2');
    expect(originalHref('d', null)).toBe('/api/documents/d/file');
  });
});
