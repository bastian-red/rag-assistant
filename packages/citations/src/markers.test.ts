import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_MARKER_BODY, createMarkerStream, labelsOf, parseMarkers } from './markers';

const PACKED = [1, 2, 3, 4, 5, 6];
const run = (answer: string) => parseMarkers(answer, PACKED);

/** Feed `parts` one by one and join what comes out. */
function streamed(parts: readonly string[], packed: Iterable<number> = PACKED) {
  const stream = createMarkerStream(packed);
  let text = '';
  const cited: number[] = [];
  for (const part of parts) {
    const out = stream.push(part);
    text += out.text;
    cited.push(...out.cited);
  }
  const last = stream.end();
  text += last.text;
  cited.push(...last.cited);
  return { text, cited, all: stream.cited(), dropped: stream.dropped() };
}

describe('markers in a whole answer', () => {
  it('keeps a valid marker as it is', () => {
    expect(run('The deposit is 1,325 pounds [S2].').text).toBe('The deposit is 1,325 pounds [S2].');
  });

  it('writes every accepted spelling in one canonical form', () => {
    expect(run('a [S1, S3] b [S1;S2] c [s4] d [S2-S4] e [ S5 , S6 ]').text).toBe(
      'a [S1][S3] b [S1][S2] c [S4] d [S2][S3][S4] e [S5][S6]',
    );
    expect(run('a [S1 S3]').text).toBe('a [S1][S3]');
    expect(run('a [S2, S2]').text).toBe('a [S2]');
    expect(run('a [S1-3]').text).toBe('a [S1][S2][S3]');
  });

  it('drops a marker naming nothing packed, with the space before it, and counts it', () => {
    const result = run('Pressure is 1.3 bar [S9]. It was checked [S7] in May.');
    expect(result.text).toBe('Pressure is 1.3 bar. It was checked in May.');
    expect(result.dropped).toEqual([
      { raw: '[S9]', labels: [9] },
      { raw: '[S7]', labels: [7] },
    ]);
    expect(result.cited).toEqual([]);
  });

  it('keeps the valid half of a marker and counts the other half', () => {
    const result = run('Due in May [S2, S9].');
    expect(result.text).toBe('Due in May [S2].');
    expect(result.dropped).toEqual([{ raw: '[S2, S9]', labels: [9] }]);
    expect(result.cited).toEqual([2]);
  });

  it('keeps one space when a dropped marker sits between words', () => {
    expect(run('as agreed [S9] and signed').text).toBe('as agreed and signed');
    expect(run('as agreed [S9]and signed').text).toBe('as agreed and signed');
    expect(run('as agreed[S9] and signed').text).toBe('as agreed and signed');
  });

  it('leaves other bracketed text alone', () => {
    for (const text of [
      'see [note]',
      'ref [1]',
      'a [S] b',
      'x [S1-S30] y',
      'x [S3-S1] y',
      '[[S1]]',
      'a [S1 b',
    ]) {
      expect(run(text).dropped).toEqual([]);
    }
    expect(run('see [note] and [1]').text).toBe('see [note] and [1]');
    expect(run('[[S1]]').text).toBe('[[S1]]');
    // A range over MAX_RANGE or backwards is not a marker at all.
    expect(run('x [S1-S30] y').text).toBe('x [S1-S30] y');
  });

  it('records citations in first-use order, without repeats', () => {
    expect(run('a [S3] b [S1] c [S3][S2]').cited).toEqual([3, 1, 2]);
  });

  it('keeps line breaks and trailing spaces it has no reason to touch', () => {
    expect(run('One [S1].\n\nTwo  [S2]  \n').text).toBe('One [S1].\n\nTwo  [S2]  \n');
    expect(run('End [S9]  ').text).toBe('End');
  });

  it('treats a marker body over the limit as text', () => {
    const body = `S1${', S2'.repeat(20)}`;
    expect(body.length).toBeGreaterThan(MAX_MARKER_BODY);
    expect(run(`a [${body}] b`).text).toBe(`a [${body}] b`);
    const fits = `S1${', S2'.repeat(9)}`;
    expect(fits.length).toBeLessThanOrEqual(MAX_MARKER_BODY);
    expect(run(`a [${fits}] b`).text).toBe('a [S1][S2] b');
  });

  it('parses label lists', () => {
    expect(labelsOf('[S1, S3-S5]')).toEqual([1, 3, 4, 5]);
    expect(labelsOf('[S1 x]')).toBeNull();
    expect(labelsOf('[S1-S11]')).toBeNull();
    expect(labelsOf('[S1-S10]')).toHaveLength(10);
  });
});

describe('markers across stream deltas', () => {
  it('parses a marker split across tokens', () => {
    const result = streamed(['The gauge reads 1.3 bar [', 'S', '1', ']', '.']);
    expect(result.text).toBe('The gauge reads 1.3 bar [S1].');
    expect(result.cited).toEqual([1]);
  });

  it('holds a possible marker until it is decided, and no longer', () => {
    const stream = createMarkerStream(PACKED);
    expect(stream.push('Due [S').text).toBe('Due');
    expect(stream.push('1').text).toBe('');
    expect(stream.push(', S9] now').text).toBe(' [S1] now');
    // "[n" cannot open a marker, so it is text at once.
    expect(stream.push(' [note').text).toBe(' [note');
    expect(stream.push('s] ok').text).toBe('s] ok');
    expect(stream.dropped()).toEqual([{ raw: '[S1, S9]', labels: [9] }]);
  });

  it('flushes an unfinished marker as text at the end', () => {
    expect(streamed(['Stopped mid [S', '2']).text).toBe('Stopped mid [S2');
  });

  it('refuses input after the end', () => {
    const stream = createMarkerStream(PACKED);
    stream.end();
    expect(() => stream.push('x')).toThrow(/ended/u);
    expect(() => stream.end()).toThrow(/ended/u);
  });

  const fragment = fc.oneof(
    {
      weight: 6,
      arbitrary: fc.constantFrom('The', 'boiler', 'is', 'due', '1.3', 'bar', 'May', 'S1', 'x'),
    },
    { weight: 6, arbitrary: fc.constantFrom(' ', ' ', '  ', '\n', '\n\n') },
    { weight: 3, arbitrary: fc.constantFrom('.', ',', ';', '!', '?', ')', '(', ':') },
    {
      weight: 4,
      arbitrary: fc.constantFrom(
        '[S1]',
        '[s2]',
        '[S1, S3]',
        '[S1;S2]',
        '[S2-S4]',
        '[S9]',
        '[S2, S9]',
        '[S 1]',
        '[S1-S30]',
        '[S]',
        '[note]',
        '[1]',
        '[S1',
        ']',
        '[',
        '[[S1]]',
        `[S1${', S2'.repeat(20)}]`,
      ),
    },
    { weight: 1, arbitrary: fc.integer({ min: 0, max: 12 }).map((n) => `[S${n}]`) },
  );
  const answer = fc.array(fragment, { maxLength: 60 }).map((parts) => parts.join(''));

  /** Cut a string at arbitrary points. */
  const cuts = (text: string) =>
    fc.uniqueArray(fc.integer({ min: 0, max: text.length }), { maxLength: 20 }).map((points) => {
      const sorted = [...points].sort((a, b) => a - b);
      const parts: string[] = [];
      let from = 0;
      for (const p of sorted) {
        parts.push(text.slice(from, p));
        from = p;
      }
      parts.push(text.slice(from));
      return parts;
    });

  it('gives the same result however the answer is split (split invariance)', () => {
    fc.assert(
      fc.property(
        answer.chain((text) => fc.tuple(fc.constant(text), cuts(text))),
        fc.subarray([1, 2, 3, 4, 5, 6, 9]),
        ([text, parts], packed) => {
          const whole = streamed([text], packed);
          const split = streamed(parts, packed);
          expect(split.text).toBe(whole.text);
          expect(split.cited).toEqual(whole.cited);
          expect(split.all).toEqual(whole.all);
          expect(split.dropped).toEqual(whole.dropped);
        },
      ),
    );
  });

  it('outputs only canonical markers naming packed sources, and loses no other text', () => {
    fc.assert(
      fc.property(answer, fc.subarray([1, 2, 3, 4, 5, 6, 9]), (text, packed) => {
        const out = streamed([text], packed);
        const valid = new Set(packed);
        for (const label of out.all) expect(valid.has(label)).toBe(true);
        // Dropped labels are exactly the unpacked labels of complete markers.
        const markers = [...text.matchAll(/\[[\sSs0-9,;-]{0,40}\]/gu)]
          .map((m) => labelsOf(m[0]))
          .filter((l): l is number[] => l !== null);
        expect(out.dropped.flatMap((d) => d.labels)).toEqual(
          markers.flat().filter((n) => !valid.has(n)),
        );
        expect(out.all).toEqual([...new Set(markers.flat().filter((n) => valid.has(n)))]);
        // Removing every marker from both sides leaves the same visible text.
        const visible = (s: string) => s.replace(/\s+/gu, '');
        const bare = text.replace(/\[[\sSs0-9,;-]{0,40}\]/gu, (m) =>
          labelsOf(m) === null ? m : '',
        );
        expect(visible(out.text.replace(/\[S\d+\]/gu, ''))).toBe(
          visible(bare.replace(/\[S\d+\]/gu, '')),
        );
      }),
    );
  });
});
