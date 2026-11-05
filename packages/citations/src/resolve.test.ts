import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chunkDocument, sliceCodePoints } from '@rag/chunker';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  claimsOf,
  contentWords,
  coverage,
  partOf,
  resolveCitations,
  stripMarkers,
  type PackedSource,
} from './resolve';

const boiler = chunkDocument({
  format: 'markdown',
  text: readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'db',
      'prisma',
      'corpus',
      'alma',
      'home',
      'boiler-service-record.md',
    ),
    'utf8',
  ),
});
const sources: PackedSource[] = boiler.chunks.map((chunk, i) => ({
  marker: i + 1,
  chunkId: `chunk-${chunk.ord}`,
  documentTitle: 'Boiler service record',
  page: chunk.pageStart,
  text: chunk.text,
}));

describe('claimsOf', () => {
  it('splits sentences and list items, moving a leading marker back', () => {
    expect(
      claimsOf(
        'The boiler is due in May [S1]. It needs a filter. [S2] Done.\n\n- One item [S3]\n- Two',
      ),
    ).toEqual([
      { text: 'The boiler is due in May.', markers: [1] },
      { text: 'It needs a filter.', markers: [2] },
      { text: 'Done.', markers: [] },
      { text: '- One item', markers: [3] },
      { text: '- Two', markers: [] },
    ]);
  });

  it('gives a markers-only line to the claim before it', () => {
    expect(claimsOf('Pressure is 1.3 bar.\n\n[S1][S2]')).toEqual([
      { text: 'Pressure is 1.3 bar.', markers: [1, 2] },
    ]);
  });
});

describe('coverage', () => {
  it('counts claims of four words or more that carry a marker', () => {
    expect(coverage('The boiler is due in May [S1]. It needs a new filter. Yes.')).toEqual({
      claims: 2,
      cited: 1,
      ratio: 0.5,
    });
  });

  it('has no ratio when nothing was claimed', () => {
    expect(coverage('Yes.')).toEqual({ claims: 0, cited: 0, ratio: null });
  });
});

describe('stripMarkers', () => {
  it('removes markers and the space before them', () => {
    expect(stripMarkers('Due in May [S1][S2]. Filter [S3] next.')).toBe('Due in May. Filter next.');
  });
});

describe('contentWords', () => {
  it('drops stop words and keeps numbers whole', () => {
    expect([...contentWords('The pressure is 1.3 bar, in the Boiler.')]).toEqual([
      'pressure',
      '1.3',
      'bar',
      'boiler',
    ]);
  });
});

describe('resolveCitations', () => {
  it('quotes the source sentence the claim leans on, as an exact span', () => {
    const pressure = sources.find((s) => s.text.startsWith('## Pressure'))!;
    const answer = `Bleeding the radiators lowers the pressure [S${pressure.marker}].`;
    const [citation] = resolveCitations(answer, sources);
    expect(citation).toBeDefined();
    expect(citation!.marker).toBe(pressure.marker);
    expect(citation!.quote).toMatch(/bleeding lowers it/u);
    expect(sliceCodePoints(pressure.text, citation!.quoteStart, citation!.quoteEnd)).toBe(
      citation!.quote,
    );
  });

  it('resolves in first-use order and skips labels with no source', () => {
    const answer = 'One thing [S3]. Another [S1]. A third [S9]. Again [S3].';
    expect(resolveCitations(answer, sources).map((c) => c.marker)).toEqual([3, 1]);
  });

  it('falls back to the first unit when nothing is shared', () => {
    const [citation] = resolveCitations('Unrelated words entirely [S2].', sources);
    const first = sources[1]!.text.split('\n')[2]!;
    expect(first.startsWith(citation!.quote.slice(0, 20))).toBe(true);
  });

  it('counts quote offsets in code points', () => {
    const emoji = String.fromCodePoint(0x1f642);
    const source: PackedSource = {
      marker: 1,
      chunkId: 'c',
      documentTitle: 'Notes',
      page: 2,
      text: `${emoji} Intro line here. The valve was replaced in March.`,
    };
    const [citation] = resolveCitations('The valve was replaced [S1].', [source]);
    expect(citation!.quote).toBe('The valve was replaced in March.');
    const before = source.text.slice(0, source.text.indexOf('The valve'));
    // The emoji is two UTF-16 units and one code point.
    expect(citation!.quoteStart).toBe(Array.from(before).length);
    expect(citation!.quoteStart).toBe(before.length - 1);
    expect(citation!.quoteEnd - citation!.quoteStart).toBe(Array.from(citation!.quote).length);
    expect(citation!.page).toBe(2);
  });

  it('gives the page the quote is on, not the chunk first page', () => {
    const doc = chunkDocument({
      format: 'pdf',
      pages: ['The valve sits low in the cupboard.', 'It was replaced in March.'],
    });
    const chunk = doc.chunks[0]!;
    const source: PackedSource = {
      marker: 1,
      chunkId: 'c',
      documentTitle: 'Notes',
      page: chunk.pageStart,
      pageStarts: chunk.pageStarts,
      text: chunk.text,
    };
    expect(resolveCitations('The valve was replaced in March [S1].', [source])[0]!.page).toBe(2);
    expect(resolveCitations('The valve sits low in the cupboard [S1].', [source])[0]!.page).toBe(1);
  });

  it('always returns a span of its source', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('pressure', 'boiler', 'bar', 'May', 'filter', 'x'), {
          maxLength: 12,
        }),
        fc.subarray(
          sources.map((s) => s.marker),
          { minLength: 1 },
        ),
        (words, cited) => {
          const answer = `${words.join(' ')} ${cited.map((n) => `[S${n}]`).join('')}.`;
          for (const citation of resolveCitations(answer, sources)) {
            const source = sources.find((s) => s.marker === citation.marker)!;
            expect(sliceCodePoints(source.text, citation.quoteStart, citation.quoteEnd)).toBe(
              citation.quote,
            );
            expect(citation.quote.trim()).toBe(citation.quote);
            expect(citation.quote.length).toBeGreaterThan(0);
          }
        },
      ),
    );
  });
});

describe('a source merged from overlapping neighbours', () => {
  // Two sections long enough to split, so chunks 0-1-2 overlap (one section).
  const sentence = (n: number) =>
    `Valve ${String(n)} opens when the pressure passes ${String(n)} bar and closes below it. `;
  const text = `## Valves\n\n${Array.from({ length: 60 }, (_, i) => sentence(i + 1)).join('')}\n`;
  const doc = chunkDocument({ format: 'markdown', text });
  const [first, second] = doc.chunks;

  it('needs chunks that overlap (the fixture holds what the test assumes)', () => {
    expect(second!.charStart).toBeLessThan(first!.charEnd);
  });

  const union = sliceCodePoints(doc.text, first!.charStart, second!.charEnd);
  const merged: PackedSource = {
    marker: 1,
    chunkId: 'first',
    documentTitle: 'Valves',
    page: null,
    text: union,
    parts: [
      { chunkId: 'first', at: 0, length: first!.charEnd - first!.charStart, page: null },
      {
        chunkId: 'second',
        at: second!.charStart - first!.charStart,
        length: second!.charEnd - second!.charStart,
        page: null,
      },
    ],
  };
  // The last valve sentence of the second chunk exists only in it.
  const onlyInSecond = second!.text.trim().split('. ').at(-2)!;

  it('stores a quote against the chunk it is in, with that chunk’s offsets', () => {
    const [citation] = resolveCitations(`${onlyInSecond} [S1].`, [merged]);
    expect(citation!.chunkId).toBe('second');
    expect(sliceCodePoints(second!.text, citation!.quoteStart, citation!.quoteEnd)).toBe(
      citation!.quote,
    );
    expect(citation!.quote).toContain(onlyInSecond);
  });

  it('stores a quote from the first part against the first chunk', () => {
    const [citation] = resolveCitations('Valve 1 opens when the pressure passes 1 bar [S1].', [
      merged,
    ]);
    expect(citation!.chunkId).toBe('first');
    expect(sliceCodePoints(first!.text, citation!.quoteStart, citation!.quoteEnd)).toBe(
      citation!.quote,
    );
  });

  it('always stores a non-empty span of the chunk it names, whatever is cited', () => {
    const texts = new Map([
      ['first', first!.text],
      ['second', second!.text],
    ]);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 60 }), (n) => {
        for (const citation of resolveCitations(`Valve ${String(n)} opens [S1].`, [merged])) {
          const chunk = texts.get(citation.chunkId)!;
          expect(citation.quoteEnd).toBeGreaterThan(citation.quoteStart);
          expect(sliceCodePoints(chunk, citation.quoteStart, citation.quoteEnd)).toBe(
            citation.quote,
          );
        }
      }),
    );
  });

  it('partOf: the first part holding the whole span, else cut at the end of the one it starts in', () => {
    const [one, two] = merged.parts!;
    // Inside the overlap: both hold it, the first wins.
    expect(partOf(merged, two!.at, two!.at + 4)).toEqual({
      part: one,
      start: two!.at,
      end: two!.at + 4,
    });
    // Starts in the overlap, ends past the first: the second holds all of it.
    expect(partOf(merged, one!.length - 2, one!.length + 3)).toEqual({
      part: two,
      start: one!.length - 2 - two!.at,
      end: one!.length + 3 - two!.at,
    });
    // Runs past the end of the source: cut at the last part's end.
    const last = two!.at + two!.length;
    expect(partOf(merged, last - 3, last + 10)).toEqual({
      part: two,
      start: two!.length - 3,
      end: two!.length,
    });
  });
});
