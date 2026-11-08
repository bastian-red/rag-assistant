import { parseMarkers } from '@rag/citations';
import { formatSources } from '@rag/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { NOT_FOUND, resolveCites, scriptedAnswer, streamPieces } from './answer';

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

describe('resolveCites', () => {
  const prompt = formatSources([
    { marker: 1, title: 'Lease summary', page: null, text: 'The rent is reviewed every April.' },
    {
      marker: 2,
      title: 'Boiler service record',
      page: null,
      text: 'The warranty ends in March 2028.',
    },
  ]);
  const messages = [{ role: 'user' as const, content: `${prompt}\n\nWhen does it end?` }];

  it('cites the source that holds the words, wherever retrieval put it', () => {
    expect(resolveCites('It ends in March 2028 [S:March 2028].', messages)).toBe(
      'It ends in March 2028 [S2].',
    );
    expect(resolveCites('Rent [S:every April], warranty [S:warranty ends].', messages)).toBe(
      'Rent [S1], warranty [S2].',
    );
  });

  it('leaves a needle no source holds as written, and plain markers alone', () => {
    expect(resolveCites('Nowhere [S:zebra].', messages)).toBe('Nowhere [S:zebra].');
    expect(resolveCites('Plain [S1].', messages)).toBe('Plain [S1].');
  });
});
