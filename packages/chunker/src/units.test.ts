import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { document, messyText } from '../test/arbitraries';
import { looksLikeHeading, unitsOf } from './blocks';
import { normalise } from './normalise';
import { codePointOffsets, sliceCodePoints, utf16Offset, utf16Offsets } from './offsets';
import { sentenceSpans } from './sentences';

const EMOJI = String.fromCodePoint(0x1f642);

describe('code-point offsets', () => {
  it('count an emoji as one, as Postgres char_length does', () => {
    const text = `a${EMOJI}b`;
    expect(text.length).toBe(4);
    const points = codePointOffsets(text);
    expect([0, 1, 3, 4].map(points)).toEqual([0, 1, 2, 3]);
    expect(sliceCodePoints(text, 2, 3)).toBe('b');
    expect(utf16Offset(text, 2)).toBe(3);
  });

  it('are the identity on text inside the BMP', () => {
    const points = codePointOffsets('plain café');
    expect(points(7)).toBe(7);
  });

  it('round-trip on any text', () => {
    fc.assert(
      fc.property(messyText, (text) => {
        const points = codePointOffsets(text);
        const units = utf16Offsets(text);
        const total = Array.from(text).length;
        if (points(text.length) !== total) return false;
        for (let p = 0; p <= total; p += 1) {
          if (points(units(p)) !== p) return false;
        }
        // The single-lookup form agrees with the map, sampled.
        return [0, total >> 1, total].every((p) => utf16Offset(text, p) === units(p));
      }),
    );
  });
});

describe('sentenceSpans', () => {
  const sentences = (text: string) => sentenceSpans(text).map((s) => text.slice(s.start, s.end));

  it('splits at sentence ends', () => {
    expect(sentences('Bleed the radiators. Then top up!  Done?')).toEqual([
      'Bleed the radiators.',
      'Then top up!',
      'Done?',
    ]);
  });

  it('does not break after a title or an initial', () => {
    expect(sentences('Ask Dr. Okafor about it. Mr. P. Adeyemi signs.')).toEqual([
      'Ask Dr. Okafor about it.',
      'Mr. P. Adeyemi signs.',
    ]);
  });

  it('does not break inside e.g., a decimal or a time', () => {
    expect(sentences('Top up, e.g. to 1.5 bar, by 8 p.m. on Friday. Next.')).toEqual([
      'Top up, e.g. to 1.5 bar, by 8 p.m. on Friday.',
      'Next.',
    ]);
  });

  it('reads through a hard line wrap', () => {
    expect(sentences('The gauge should\nread 1.3 bar. It does.')).toEqual([
      'The gauge should\nread 1.3 bar.',
      'It does.',
    ]);
  });

  it('works on a sub-range with absolute offsets', () => {
    const text = 'Skip this. Keep this. And this.';
    const spans = sentenceSpans(text, 11);
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(['Keep this.', 'And this.']);
  });
});

describe('unitsOf', () => {
  const view = (text: string, format: 'markdown' | 'text') =>
    unitsOf(text, format).map((u) => [u.kind, text.slice(u.start, u.end), u.level, u.title]);

  it('reads markdown structure', () => {
    const text = [
      '# Boiler',
      '',
      'One. Two.',
      '',
      '## Notes for C#',
      '',
      '- first item',
      '  wraps here',
      '2) second',
      '',
      '| a | b |',
      '|---|---|',
      '',
      '```',
      '# not a heading',
      '',
      'x = 1. y = 2.',
      '```',
      'After.',
    ].join('\n');
    expect(view(text, 'markdown')).toEqual([
      ['heading', '# Boiler', 1, 'Boiler'],
      ['sentence', 'One.', undefined, undefined],
      ['sentence', 'Two.', undefined, undefined],
      ['heading', '## Notes for C#', 2, 'Notes for C#'],
      ['item', '- first item\n  wraps here', undefined, undefined],
      ['item', '2) second', undefined, undefined],
      ['row', '| a | b |', undefined, undefined],
      ['row', '|---|---|', undefined, undefined],
      ['code', '```', undefined, undefined],
      ['code', '# not a heading', undefined, undefined],
      ['code', 'x = 1. y = 2.', undefined, undefined],
      ['code', '```', undefined, undefined],
      ['sentence', 'After.', undefined, undefined],
    ]);
  });

  it('strips a closing hash run but not a hash that is part of the title', () => {
    expect(view('## Pressure ##', 'markdown')).toEqual([
      ['heading', '## Pressure ##', 2, 'Pressure'],
    ]);
  });

  it('runs an unclosed fence to the end of the text', () => {
    expect(view('```\ncode\n\nmore', 'markdown').map((u) => u[0])).toEqual([
      'code',
      'code',
      'code',
    ]);
  });

  it('reads plain text headings by shape', () => {
    expect(
      view(
        'Every month\n\nMeasure the chain. Oil it.\n\nNote:\n\nA long line that has more than eight words in it',
        'text',
      ),
    ).toEqual([
      ['heading', 'Every month', 1, 'Every month'],
      ['sentence', 'Measure the chain.', undefined, undefined],
      ['sentence', 'Oil it.', undefined, undefined],
      ['sentence', 'Note:', undefined, undefined],
      ['sentence', 'A long line that has more than eight words in it', undefined, undefined],
    ]);
  });

  it('never treats markdown markup in plain text as structure', () => {
    expect(view('# not markup here, just text.', 'text').map((u) => u[0])).toEqual(['sentence']);
  });

  it('knows a heading from a sentence', () => {
    expect(looksLikeHeading('Pets and subletting')).toBe(true);
    expect(looksLikeHeading('2026')).toBe(false);
    expect(looksLikeHeading('Call the agent.')).toBe(false);
    expect(looksLikeHeading('- an item')).toBe(false);
  });

  it('puts every visible character in exactly one unit, in order', () => {
    fc.assert(
      fc.property(
        fc.oneof(document, messyText),
        fc.constantFrom('markdown', 'text') as fc.Arbitrary<'markdown' | 'text'>,
        (raw, format) => {
          const text = normalise(raw);
          const units = unitsOf(text, format);
          let at = 0;
          for (const unit of units) {
            if (unit.start < at || unit.end <= unit.start) return false;
            if (/\S/u.test(text.slice(at, unit.start))) return false;
            const body = text.slice(unit.start, unit.end);
            if (body.trim() !== body) return false;
            at = unit.end;
          }
          return !/\S/u.test(text.slice(at));
        },
      ),
    );
  });
});
