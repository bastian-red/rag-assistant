import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { document, messyText } from '../test/arbitraries';
import { unitsOf } from './blocks';
import {
  chunkDocument,
  DEFAULT_CHUNK_OPTIONS,
  MIN_CUT_TOKENS,
  splitSpan,
  type ChunkOptions,
  type ChunkedDocument,
} from './chunk';
import { assemblePages, normalise } from './normalise';
import { sliceCodePoints, utf16Offsets } from './offsets';
import { estimateTokens } from './tokens';

const SMALL: ChunkOptions = { targetTokens: 40, maxTokens: 52, overlapTokens: 8, minTokens: 10 };
const options = fc.constantFrom(DEFAULT_CHUNK_OPTIONS, SMALL);
const format = fc.constantFrom('markdown', 'text') as fc.Arbitrary<'markdown' | 'text'>;

const CORPUS = join(__dirname, '..', '..', 'db', 'prisma', 'corpus');
const corpus = (readdirSync(CORPUS, { recursive: true }) as string[])
  .filter((file) => /\.(md|txt)$/u.test(file))
  .sort()
  .map((file) => ({ file, raw: readFileSync(join(CORPUS, file), 'utf8') }));

/** Code-point view of a document: every check below works in code points. */
const points = (doc: ChunkedDocument) => Array.from(doc.text);

/**
 * The SPECS outcome, literally: joined, minus overlap, the chunks are the
 * source. Returns null on success or what went wrong.
 */
function stitchProblem(doc: ChunkedDocument): string | null {
  const text = points(doc);
  const chunks = doc.chunks;
  if (chunks.length === 0) return /\S/u.test(doc.text) ? 'no chunks for a non-blank text' : null;
  if (/\S/u.test(text.slice(0, chunks[0]!.charStart).join('')))
    return 'text before the first chunk';
  if (/\S/u.test(text.slice(chunks.at(-1)!.charEnd).join(''))) return 'text after the last chunk';
  let stitched = chunks[0]!.text;
  for (let i = 1; i < chunks.length; i += 1) {
    const before = chunks[i - 1]!;
    const chunk = chunks[i]!;
    if (chunk.charStart >= before.charEnd) {
      const gap = text.slice(before.charEnd, chunk.charStart).join('');
      if (/\S/u.test(gap)) return `text lost between chunks ${i - 1} and ${i}`;
      stitched += gap + chunk.text;
    } else {
      // Overlap: only the part after the previous chunk's end is new.
      stitched += Array.from(chunk.text)
        .slice(before.charEnd - chunk.charStart)
        .join('');
    }
  }
  const whole = text.slice(chunks[0]!.charStart, chunks.at(-1)!.charEnd).join('');
  return stitched === whole ? null : 'stitched chunks differ from the source';
}

function invariants(doc: ChunkedDocument, o: ChunkOptions): string | null {
  const text = points(doc);
  for (const [i, chunk] of doc.chunks.entries()) {
    if (chunk.ord !== i) return `ord ${chunk.ord} at ${i}`;
    if (text.slice(chunk.charStart, chunk.charEnd).join('') !== chunk.text)
      return `chunk ${i} is not its span`;
    if (chunk.charEnd - chunk.charStart !== Array.from(chunk.text).length)
      return `chunk ${i} length`;
    if (chunk.text.trim() === '' || chunk.text.trim() !== chunk.text)
      return `chunk ${i} blank or padded`;
    if (chunk.tokens !== estimateTokens(chunk.text)) return `chunk ${i} token count`;
    if (chunk.tokens > o.maxTokens) return `chunk ${i} has ${chunk.tokens} tokens`;
    const before = doc.chunks[i - 1];
    if (before === undefined) continue;
    if (chunk.charStart <= before.charStart || chunk.charEnd <= before.charEnd)
      return `chunk ${i} out of order`;
    if (chunk.charStart < before.charEnd) {
      const shared = text.slice(chunk.charStart, before.charEnd).join('');
      if (estimateTokens(shared) > o.overlapTokens)
        return `chunk ${i} overlaps by ${estimateTokens(shared)}`;
    }
  }
  return stitchProblem(doc);
}

/**
 * Whether every chunk starts and ends on a unit boundary, except inside a
 * unit too big for one chunk, which the packer has to cut.
 */
function onUnitBoundaries(doc: ChunkedDocument, f: 'markdown' | 'text', o: ChunkOptions): boolean {
  const units = unitsOf(doc.text, f);
  const starts = new Set(units.map((u) => u.start));
  const ends = new Set(units.map((u) => u.end));
  // A unit may be cut when it is over the target, or when it cannot fit
  // beside the run of headings right before it.
  let headings = 0;
  const cut = units.filter((u) => {
    const tokens = estimateTokens(doc.text.slice(u.start, u.end));
    if (u.kind === 'heading' && tokens <= o.targetTokens) {
      headings += tokens;
      return false;
    }
    const cuttable = tokens > o.targetTokens || (headings > 0 && headings + tokens > o.maxTokens);
    headings = 0;
    return cuttable;
  });
  const inCut = (at: number) => cut.some((u) => u.start <= at && at <= u.end);
  const utf16 = utf16Offsets(doc.text);
  return doc.chunks.every((chunk) => {
    const start = utf16(chunk.charStart);
    const end = utf16(chunk.charEnd);
    return (starts.has(start) || inCut(start)) && (ends.has(end) || inCut(end));
  });
}

describe('chunkDocument: the span and coverage guarantees', () => {
  it('holds on any document, at both chunk sizes', () => {
    fc.assert(
      fc.property(fc.oneof(document, messyText), format, options, (raw, f, o) => {
        const doc = chunkDocument({ format: f, text: raw }, o);
        if (doc.text !== normalise(raw)) return false;
        const problem = invariants(doc, o);
        if (problem !== null) throw new Error(problem);
        return true;
      }),
    );
  });

  it('starts and ends chunks on unit boundaries unless a unit had to be cut', () => {
    fc.assert(
      fc.property(fc.oneof(document, messyText), format, options, (raw, f, o) =>
        onUnitBoundaries(chunkDocument({ format: f, text: raw }, o), f, o),
      ),
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(messyText, format, options, (raw, f, o) => {
        const once = chunkDocument({ format: f, text: raw }, o);
        const twice = chunkDocument({ format: f, text: raw }, o);
        expect(twice).toEqual(once);
      }),
    );
  });

  it('gives a blank document no chunks', () => {
    expect(chunkDocument({ format: 'markdown', text: ' \n\r\n\t ' }).chunks).toEqual([]);
    expect(chunkDocument({ format: 'pdf', pages: ['', '   '] })).toEqual({
      text: '',
      pageCount: 2,
      chunks: [],
    });
  });

  it('counts offsets in code points when the text has emoji', () => {
    const emoji = String.fromCodePoint(0x1f642);
    const raw = `${emoji} First part. ${emoji}\n\n# Next\n\nSecond ${emoji} part.`;
    const doc = chunkDocument(
      { format: 'markdown', text: raw },
      { ...SMALL, targetTokens: 12, maxTokens: 12, overlapTokens: 0, minTokens: 1 },
    );
    expect(doc.chunks.length).toBeGreaterThan(1);
    for (const chunk of doc.chunks) {
      expect(sliceCodePoints(doc.text, chunk.charStart, chunk.charEnd)).toBe(chunk.text);
    }
    const last = doc.chunks.at(-1)!;
    // Three emoji: in UTF-16 the last chunk would end three units later.
    expect(last.charEnd).toBe(Array.from(doc.text).length);
    expect(last.charEnd).toBe(doc.text.length - 3);
  });

  it('rejects options that cannot be honoured', () => {
    const bad = (o: Partial<ChunkOptions>) => () =>
      chunkDocument({ format: 'text', text: 'x' }, { ...DEFAULT_CHUNK_OPTIONS, ...o });
    expect(bad({ targetTokens: 600 })).toThrow(/maxTokens/u);
    expect(bad({ overlapTokens: 400 })).toThrow(/overlapTokens/u);
    expect(bad({ minTokens: 401 })).toThrow(/minTokens/u);
    expect(bad({ targetTokens: 7, minTokens: 1, overlapTokens: 1 })).toThrow(/at least 8/u);
    expect(bad({ overlapTokens: 1.5 })).toThrow(RangeError);
  });
});

describe('chunkDocument: pages', () => {
  it('gives every chunk the page range of its own text', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(document, messyText, fc.constant('')), { maxLength: 6 }),
        options,
        (raw, o) => {
          const doc = chunkDocument({ format: 'pdf', pages: raw }, o);
          const { pages } = assemblePages(raw);
          const pageOf = (utf16: number) =>
            pages.find((p) => p.start <= utf16 && utf16 < p.end)!.page;
          if (doc.pageCount !== raw.length || invariants(doc, o) !== null) return false;
          const utf16 = utf16Offsets(doc.text);
          return doc.chunks.every((chunk) => {
            const first = utf16(chunk.charStart);
            const last = utf16(chunk.charEnd - 1);
            if (chunk.pageStart !== pageOf(first) || chunk.pageEnd !== pageOf(last)) return false;
            // Every visible character's page, read through pageStarts, is its own page.
            const chars = Array.from(chunk.text);
            for (let q = 0; q < chars.length; q += 1) {
              if (/\s/u.test(chars[q]!)) continue;
              const page =
                chunk.pageStarts.filter((s) => s.at <= q).at(-1)?.page ?? chunk.pageStart;
              if (page !== pageOf(utf16(chunk.charStart + q))) return false;
            }
            return true;
          });
        },
      ),
    );
  });

  it('numbers pages right after a blank page, across a page break', () => {
    const filler = 'The cabinet airflow is checked before every session and logged by hand. '
      .repeat(3)
      .trim();
    const doc = chunkDocument(
      {
        format: 'pdf',
        pages: [`Intro\n\n${filler}`, '', `Waste\n\n${filler}`, `${filler} The end.`],
      },
      { targetTokens: 60, maxTokens: 80, overlapTokens: 0, minTokens: 10 },
    );
    const pagesOf = doc.chunks.map((c) => [c.pageStart, c.pageEnd, c.headingPath.join(' > ')]);
    expect(doc.chunks.every((c) => c.pageStarts.length === 0)).toBe(true);
    expect(pagesOf).toEqual([
      [1, 1, 'Intro'],
      [3, 3, 'Waste'],
      [4, 4, 'Waste'],
    ]);
    expect(doc.pageCount).toBe(4);
  });

  it('records where a later page begins inside a chunk', () => {
    const doc = chunkDocument({
      format: 'pdf',
      pages: ['The valve sits low.', '', 'It was replaced in March.'],
    });
    expect(doc.chunks).toHaveLength(1);
    const chunk = doc.chunks[0]!;
    expect([chunk.pageStart, chunk.pageEnd]).toEqual([1, 3]);
    expect(chunk.pageStarts).toEqual([{ page: 3, at: chunk.text.indexOf('It was') }]);
  });

  it('leaves markdown and text without pages', () => {
    const doc = chunkDocument({ format: 'markdown', text: '# A\n\nSome text.' });
    expect(doc.pageCount).toBeNull();
    expect(
      doc.chunks.every(
        (c) => c.pageStart === null && c.pageEnd === null && c.pageStarts.length === 0,
      ),
    ).toBe(true);
  });
});

describe('chunkDocument: packing', () => {
  const sentence = (n: number) => `Sentence number ${'x'.repeat(4)} ${n} reads like a plain fact.`;
  const paragraph = Array.from({ length: 40 }, (_, i) => sentence(i)).join(' ');

  it('fills chunks toward the target and overlaps whole sentences', () => {
    // One of these sentences is about 15 tokens, so a 20-token overlap holds one.
    const o: ChunkOptions = { targetTokens: 60, maxTokens: 80, overlapTokens: 20, minTokens: 10 };
    expect(estimateTokens(sentence(10))).toBeLessThanOrEqual(o.overlapTokens);
    const doc = chunkDocument({ format: 'text', text: paragraph }, o);
    expect(doc.chunks.length).toBeGreaterThan(5);
    for (const chunk of doc.chunks.slice(0, -1)) {
      expect(chunk.tokens).toBeGreaterThan(o.targetTokens / 2);
      expect(chunk.tokens).toBeLessThanOrEqual(o.targetTokens);
    }
    for (const [i, chunk] of doc.chunks.entries()) {
      if (i === 0) continue;
      // Each chunk begins with the previous one's last sentence.
      const before = doc.chunks[i - 1]!;
      expect(chunk.charStart).toBeLessThan(before.charEnd);
      expect(before.text.endsWith(chunk.text.slice(0, before.charEnd - chunk.charStart))).toBe(
        true,
      );
      expect(chunk.text).toMatch(/^Sentence number/u);
    }
  });

  it('starts a section clean: a heading breaks the chunk, with no overlap', () => {
    const section = (title: string) =>
      `## ${title}\n\n${Array.from({ length: 4 }, (_, i) => sentence(i)).join(' ')}`;
    const doc = chunkDocument(
      { format: 'markdown', text: ['# Guide', section('One'), section('Two')].join('\n\n') },
      SMALL,
    );
    // "# Guide" is too small to stand alone, so it opens section One's chunk,
    // and that chunk is filed under both headings.
    expect(doc.chunks[0]!.text.startsWith('# Guide\n\n## One\n\nSentence')).toBe(true);
    expect(doc.chunks[0]!.headingPath).toEqual(['Guide', 'One']);
    const two = doc.chunks.find((c) => c.text.startsWith('## Two'))!;
    expect(two.headingPath).toEqual(['Guide', 'Two']);
    // No overlap into the new section: it starts after the last chunk ends.
    expect(two.charStart).toBeGreaterThan(doc.chunks[two.ord - 1]!.charEnd);
    expect(doc.chunks.filter((c) => c.text.includes('## Two'))).toEqual([two]);
  });

  it('never ends a chunk on a heading that has text after it', () => {
    fc.assert(
      fc.property(document, options, (raw, o) => {
        const doc = chunkDocument({ format: 'markdown', text: raw }, o);
        const units = unitsOf(doc.text, 'markdown');
        const cost = (u: (typeof units)[number]) => estimateTokens(doc.text.slice(u.start, u.end));
        const isHeading = (u: (typeof units)[number] | undefined) =>
          u !== undefined && u.kind === 'heading' && cost(u) <= o.targetTokens;
        const utf16 = utf16Offsets(doc.text);
        return doc.chunks.slice(0, -1).every((chunk) => {
          const last = units.findIndex((u) => u.end === utf16(chunk.charEnd));
          if (!isHeading(units[last])) return true;
          // The one exception: a run of headings that alone leaves no room to cut into.
          let run = 0;
          for (let k = last; k >= 0 && isHeading(units[k]); k -= 1) run += cost(units[k]!);
          return run > o.maxTokens - MIN_CUT_TOKENS;
        });
      }),
    );
  });

  it('cuts the text rather than leave a heading alone when the flush moved it forward', () => {
    // fast-check's counterexample from CI (seed -1105645181), as shrunk: the
    // sentence fits a chunk whole but not beside the heading, and the heading
    // only became "alone" when the flush before the sentence carried it forward.
    const raw =
      '```\n```\n\n# 100 café 10000\n\nNaïve Größe 1.5 F22 aaaaaaaa aaaaaaaaa F22 e.g. boiler Größe. A.\n\n';
    const doc = chunkDocument({ format: 'markdown', text: raw }, SMALL);
    const heading = doc.chunks.find((c) => c.text.includes('# 100 café 10000'))!;
    expect(heading.text).not.toBe('# 100 café 10000');
    expect(heading.text.startsWith('# 100 café 10000\n\nNaïve Größe')).toBe(true);
    expect(heading.tokens).toBeLessThanOrEqual(SMALL.maxTokens);
  });

  it('moves a heading forward when the text after it starts a new chunk', () => {
    // Too little text to break before the heading (under minTokens), and the
    // sentence after it does not fit: the heading must go with the sentence.
    const note = 'Tiny note.';
    const long =
      'The cabinet airflow is checked before every single session and logged in the book by whoever opens the lab first thing on each working morning.';
    expect(estimateTokens(note)).toBeLessThan(SMALL.minTokens);
    expect(estimateTokens(`${note} ## Next ${long}`)).toBeGreaterThan(SMALL.targetTokens);
    expect(estimateTokens(`## Next ${long}`)).toBeLessThanOrEqual(SMALL.targetTokens);
    const doc = chunkDocument({ format: 'markdown', text: `${note}\n\n## Next\n\n${long}` }, SMALL);
    expect(doc.chunks.map((c) => c.text)).toEqual([note, `## Next\n\n${long}`]);
    expect(doc.chunks[1]!.headingPath).toEqual(['Next']);
  });

  it('keeps two large headings with a cut of the text under them', () => {
    // Found by a deep property run: 43 of 52 tokens of headings, 9 left.
    const raw = '### e.g. Größe 1.5\n\n# e.g. 2026 naïve 2026 10000\n\nGröße e.g..';
    const doc = chunkDocument({ format: 'markdown', text: raw }, SMALL);
    // 15 + 28 tokens of headings leave 9: the first word fits beside them.
    expect(doc.chunks.map((c) => [c.text, c.tokens])).toEqual([
      ['### e.g. Größe 1.5\n\n# e.g. 2026 naïve 2026 10000\n\nGröße', 48],
      ['Größe e.g..', 10],
    ]);
    // "#" closes "###", so the path is the level-1 heading alone.
    expect(doc.chunks[0]!.headingPath).toEqual(['e.g. 2026 naïve 2026 10000']);
  });

  it('does not take a long one-line block of plain text for a heading', () => {
    // Found by a deep property run: an 800-character hash and one word.
    const raw = `${'x7'.repeat(400)} a`;
    const doc = chunkDocument({ format: 'text', text: raw });
    expect(doc.chunks.every((c) => c.headingPath.length === 0)).toBe(true);
    expect(
      chunkDocument({ format: 'markdown', text: `# ${'word '.repeat(30)}\n\nBody.` }).chunks[0]!
        .headingPath,
    ).toEqual([]);
  });

  it('folds a small last chunk into the one before it', () => {
    const text = `${Array.from({ length: 6 }, (_, i) => sentence(i)).join(' ')} Short end.`;
    const doc = chunkDocument(
      { format: 'text', text },
      { targetTokens: 60, maxTokens: 120, overlapTokens: 0, minTokens: 20 },
    );
    expect(doc.chunks.at(-1)!.text.endsWith('Short end.')).toBe(true);
    expect(doc.chunks.at(-1)!.tokens).toBeGreaterThanOrEqual(20);
  });

  it('cuts an oversize unit at whitespace, and a giant word between code points', () => {
    const text = `${'alpha '.repeat(300)}${'z'.repeat(5000)} omega`;
    const pieces = splitSpan(text, 0, text.length, 50);
    expect(pieces.length).toBeGreaterThan(5);
    let at = 0;
    for (const piece of pieces) {
      expect(/\S/u.test(text.slice(at, piece.start))).toBe(false);
      expect(estimateTokens(text.slice(piece.start, piece.end))).toBeLessThanOrEqual(50);
      at = piece.end;
    }
    expect(at).toBe(text.length);
    // Word pieces end on a word; only the giant word is cut mid-word.
    expect(pieces.filter((p) => !/[a-z]$/u.test(text.slice(p.start, p.end))).length).toBe(0);
    expect(text.slice(pieces[0]!.start, pieces[0]!.end).endsWith('alpha')).toBe(true);
  });

  it('never cuts an emoji in half', () => {
    const emoji = String.fromCodePoint(0x1f642);
    const text = emoji.repeat(400);
    for (const piece of splitSpan(text, 0, text.length, 10)) {
      expect(piece.start % 2).toBe(0);
      expect(piece.end % 2).toBe(0);
    }
  });
});

describe('chunkDocument on the seed corpus', () => {
  it('reads every seed document', () => {
    expect(corpus.map((d) => d.file)).toHaveLength(5);
  });

  it('keeps each section in its own chunk at the default size, with its heading path', () => {
    const boiler = corpus.find((d) => d.file.endsWith('boiler-service-record.md'))!;
    const doc = chunkDocument({ format: 'markdown', text: boiler.raw });
    expect(doc.chunks.map((c) => c.headingPath)).toEqual([
      ['Boiler service record'],
      ['Boiler service record', 'Annual service'],
      ['Boiler service record', 'Pressure'],
    ]);
    const bike = corpus.find((d) => d.file.endsWith('.txt'))!;
    expect(
      chunkDocument({ format: 'text', text: bike.raw }).chunks.map((c) => c.headingPath),
    ).toEqual([['Commuter bike maintenance'], ['Every month'], ['Every six months']]);
  });

  it('holds every guarantee on every seed document at both sizes', () => {
    for (const { file, raw } of corpus) {
      for (const o of [DEFAULT_CHUNK_OPTIONS, SMALL]) {
        const f = file.endsWith('.md') ? 'markdown' : 'text';
        const doc = chunkDocument({ format: f, text: raw }, o);
        expect(invariants(doc, o), file).toBeNull();
        expect(onUnitBoundaries(doc, f, o), file).toBe(true);
      }
    }
  });

  it('ends every default-size chunk on a whole sentence, row or item', () => {
    for (const { file, raw } of corpus) {
      const f = file.endsWith('.md') ? 'markdown' : 'text';
      const doc = chunkDocument({ format: f, text: raw });
      const ends = new Set(unitsOf(doc.text, f).map((u) => u.end));
      const utf16 = utf16Offsets(doc.text);
      for (const chunk of doc.chunks) expect(ends.has(utf16(chunk.charEnd)), file).toBe(true);
    }
  });
});
