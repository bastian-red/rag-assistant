import { parseMarkers } from '@rag/citations';
import { formatSources } from '@rag/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { NOT_FOUND, scriptedAnswer, streamPieces } from './answer';

const ask = (content: string) => [{ role: 'user' as const, content }];

describe('scriptedAnswer', () => {
  const prompt = formatSources([
    {
      marker: 1,
      title: 'Manual',
      page: 3,
      text: '## Pressure\n\nThe gauge reads 1.5 bar. Bleed it.',
    },
    { marker: 2, title: 'Notes', page: null, text: 'Water tomatoes daily' },
    { marker: 3, title: 'Extra', page: null, text: 'A third passage.' },
  ]);

  it('quotes the first sentence of the first two sources, each with its marker', () => {
    expect(scriptedAnswer(ask(`${prompt}\n\nQuestion: pressure?`))).toBe(
      'The gauge reads 1.5 bar [S1]. Water tomatoes daily [S2].',
    );
  });

  it('cites only what it was given', () => {
    const { cited, dropped } = parseMarkers(scriptedAnswer(ask(prompt)), [1, 2, 3]);
    expect(cited).toEqual([1, 2]);
    expect(dropped).toEqual([]);
  });

  it('abstains with no sources', () => {
    expect(scriptedAnswer(ask('Question: anything?'))).toBe(NOT_FOUND);
  });

  it('reads the sources from the last user message', () => {
    const messages = [
      { role: 'system' as const, content: 'Cite [Sn].' },
      {
        role: 'user' as const,
        content: formatSources([{ marker: 9, title: 'Old', page: null, text: 'Old turn.' }]),
      },
      { role: 'assistant' as const, content: 'Old turn [S9].' },
      { role: 'user' as const, content: prompt },
    ];
    expect(scriptedAnswer(messages)).toMatch(/\[S1\].*\[S2\]/u);
  });
});

describe('streamPieces', () => {
  it('joins back to the answer exactly, for any text', () => {
    fc.assert(fc.property(fc.string({ maxLength: 80 }), (t) => streamPieces(t).join('') === t));
  });

  it('cuts a two-digit marker across pieces, as a tokenizer does', () => {
    expect(streamPieces('Gauge [S12].')).toEqual(['Gau', 'ge', ' [S1', '2].']);
  });
});
