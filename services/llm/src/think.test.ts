import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ThinkStripper } from './think';

/** The same rule, written the obvious way over the whole text. */
function reference(text: string): { visible: string; dropped: number } {
  let dropped = 0;
  const visible = text.replace(/<think>([\s\S]*?)(?:<\/think>|$)/gu, (_m, inner: string) => {
    dropped += Array.from(inner).length;
    return '';
  });
  return { visible, dropped };
}

function run(pieces: readonly string[]) {
  const strip = new ThinkStripper();
  const visible = pieces.map((p) => strip.push(p)).join('') + strip.end();
  return { visible, dropped: strip.dropped };
}

const text = fc.string({
  unit: fc.constantFrom(
    '<think>',
    '</think>',
    '<',
    '>',
    '/',
    't',
    'h',
    'i',
    'n',
    'k',
    'a',
    ' ',
    '\n',
    'é',
  ),
  maxLength: 60,
});

/** A text and arbitrary cut points, so tags land split across pieces. */
const cut = text.chain((t) =>
  fc.uniqueArray(fc.integer({ min: 0, max: t.length }), { maxLength: 8 }).map((points) => {
    const sorted = [0, ...points.sort((a, b) => a - b), t.length];
    return { t, pieces: sorted.slice(1).map((end, i) => t.slice(sorted[i], end)) };
  }),
);

describe('ThinkStripper', () => {
  it('equals the whole-text rule however the stream is cut', () => {
    fc.assert(
      fc.property(cut, ({ t, pieces }) => {
        expect(run(pieces)).toEqual(reference(t));
      }),
    );
  });

  it('removes a block split inside both tags', () => {
    expect(run(['Hi <th', 'ink>plan the ans', 'wer</thi', 'nk>there'])).toEqual({
      visible: 'Hi there',
      dropped: 15,
    });
  });

  it('holds back only what could still become a tag', () => {
    const strip = new ThinkStripper();
    expect(strip.push('a <t')).toBe('a ');
    expect(strip.push('able')).toBe('<table');
  });

  it('drops everything after an unclosed block', () => {
    expect(run(['Answer. <think>half a trace'])).toEqual({ visible: 'Answer. ', dropped: 12 });
  });

  it('passes text with no block through unchanged', () => {
    expect(run(['The gauge reads 1.5 bar [S1].'])).toEqual({
      visible: 'The gauge reads 1.5 bar [S1].',
      dropped: 0,
    });
  });
});
