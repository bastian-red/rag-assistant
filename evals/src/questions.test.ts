import { describe, expect, inject, it } from 'vitest';

import { loadManifest } from './corpus';
import { goldSpans, loadQuestions, locate, parseQuestions, splitOf } from './questions';

describe('locate', () => {
  it('finds a quote across a line break and returns code points', () => {
    const text = '🐝 one\ntwo three';
    expect(locate(text, 'one two')).toEqual({ start: 2, end: 9 });
    expect([...text].slice(2, 9).join('')).toBe('one\ntwo');
  });

  it('refuses a quote that is absent or ambiguous', () => {
    expect(() => locate('a b a b', 'a b')).toThrow(/2 times/u);
    expect(() => locate('a b', 'c d')).toThrow(/0 times/u);
  });

  it('treats regex characters in the quote as text', () => {
    expect(locate('cost (in $) is 3.5+', '(in $) is 3.5+')).toEqual({ start: 5, end: 19 });
  });
});

describe('parseQuestions', () => {
  const line = (q: object) => JSON.stringify(q);
  it('refuses a kind with the wrong number of quotes, and forbidden outside hostile', () => {
    const quote = { file: 'a.md', quote: 'eight chars' };
    expect(() =>
      parseQuestions(line({ id: 'a', kind: 'multihop', question: 'Long enough?', gold: [quote] })),
    ).toThrow(/2-5/u);
    expect(() =>
      parseQuestions(
        line({
          id: 'a',
          kind: 'answerable',
          question: 'Long enough?',
          gold: [quote],
          forbidden: ['x y z'],
        }),
      ),
    ).toThrow(/forbidden/u);
    expect(() =>
      parseQuestions(
        [1, 2]
          .map(() => line({ id: 'a', kind: 'unanswerable', question: 'Long enough?', gold: [] }))
          .join('\n'),
      ),
    ).toThrow(/twice/u);
  });
});

describe('the question set over the pinned corpus', () => {
  it('has every gold quote exactly once in the text ingest stores, and none in a refused file', () => {
    const manifest = loadManifest();
    const texts = new Map(Object.entries(inject('corpusTexts')));
    // The scan is refused, as the manifest says; everything else is read.
    for (const doc of manifest) expect(texts.get(doc.file) === null).toBe(doc.expect === 'FAILED');
    const questions = loadQuestions();
    const spans = goldSpans(questions, texts);
    expect([...spans.values()].flat().length).toBe(
      questions.reduce((n, q) => n + q.gold.length, 0),
    );
  });

  it('is big enough for the thresholds it is judged by, in both splits', () => {
    const questions = loadQuestions();
    const count = (kind: string, split?: string) =>
      questions.filter((q) => q.kind === kind && (split === undefined || splitOf(q.id) === split))
        .length;
    expect(questions.length).toBeGreaterThanOrEqual(60);
    expect(count('unanswerable')).toBeGreaterThanOrEqual(10);
    expect(count('multihop')).toBeGreaterThanOrEqual(6);
    expect(count('hostile')).toBeGreaterThanOrEqual(3);
    for (const split of ['dev', 'test']) {
      expect(count('answerable', split) + count('multihop', split)).toBeGreaterThanOrEqual(15);
      expect(count('unanswerable', split)).toBeGreaterThanOrEqual(3);
    }
  });
});
