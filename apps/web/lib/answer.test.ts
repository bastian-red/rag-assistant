import { describe, expect, it } from 'vitest';

import { markersIn, parseAnswer, parseInline, spokenAnswer } from './answer';

describe('parseInline', () => {
  it('turns markers into their own nodes', () => {
    expect(parseInline('Opens at 9:00 [S2].')).toEqual([
      { kind: 'text', text: 'Opens at 9:00 ' },
      { kind: 'marker', marker: 2 },
      { kind: 'text', text: '.' },
    ]);
  });

  it('reads adjacent markers as two', () => {
    expect(parseInline('[S1][S3]')).toEqual([
      { kind: 'marker', marker: 1 },
      { kind: 'marker', marker: 3 },
    ]);
  });

  it('leaves a marker cut by the stream as text until it is whole', () => {
    expect(parseInline('six books [S1')).toEqual([{ kind: 'text', text: 'six books [S1' }]);
  });

  it('reads bold, emphasis and code, nested where markdown nests them', () => {
    expect(parseInline('**Never** run `rm` *without* a **[S1] check**')).toEqual([
      { kind: 'strong', children: [{ kind: 'text', text: 'Never' }] },
      { kind: 'text', text: ' run ' },
      { kind: 'code', text: 'rm' },
      { kind: 'text', text: ' ' },
      { kind: 'em', children: [{ kind: 'text', text: 'without' }] },
      { kind: 'text', text: ' a ' },
      {
        kind: 'strong',
        children: [
          { kind: 'marker', marker: 1 },
          { kind: 'text', text: ' check' },
        ],
      },
    ]);
  });

  it('keeps an unclosed opener literal, as a half-streamed answer has', () => {
    expect(parseInline('a **half')).toEqual([{ kind: 'text', text: 'a **half' }]);
  });

  it('keeps snake_case and arithmetic literal', () => {
    expect(parseInline('max_upload_bytes is 2 * 3 * 4')).toEqual([
      { kind: 'text', text: 'max_upload_bytes is 2 * 3 * 4' },
    ]);
  });

  it('never makes markup out of HTML: it is text', () => {
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([
      { kind: 'text', text: '<img src=x onerror=alert(1)>' },
    ]);
  });
});

describe('parseAnswer', () => {
  it('splits paragraphs on blank lines and joins wrapped lines', () => {
    const blocks = parseAnswer('First line\nsame paragraph.\n\nSecond.');
    expect(blocks).toEqual([
      { kind: 'paragraph', children: [{ kind: 'text', text: 'First line same paragraph.' }] },
      { kind: 'paragraph', children: [{ kind: 'text', text: 'Second.' }] },
    ]);
  });

  it('reads bullets and numbered items, a lead-in paragraph before them', () => {
    const blocks = parseAnswer('You need:\n- a key [S1]\n- a cloth\n1. open\n2. close');
    expect(
      blocks.map((b) =>
        b.kind === 'list' ? `${b.kind}:${String(b.ordered)}:${String(b.items.length)}` : b.kind,
      ),
    ).toEqual(['paragraph', 'list:false:2', 'list:true:2']);
  });

  it('continues an item on an indented line', () => {
    const [list] = parseAnswer('- first part\n  and the rest');
    expect(list).toEqual({
      kind: 'list',
      ordered: false,
      items: [[{ kind: 'text', text: 'first part and the rest' }]],
    });
  });

  it('is empty for an empty answer', () => {
    expect(parseAnswer('')).toEqual([]);
  });
});

describe('markersIn', () => {
  it('lists cited markers once, in written order', () => {
    expect(markersIn('a [S3] b [S1][S3] c [S2')).toEqual([3, 1]);
  });
});

describe('spokenAnswer', () => {
  it('reads without markers or markup characters', () => {
    expect(spokenAnswer('**Bleed** the radiators [S1][S2].\n\n- every `autumn` [S3]')).toBe(
      'Bleed the radiators. - every autumn',
    );
  });
});
