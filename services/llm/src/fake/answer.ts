/**
 * What the fake answers, and how it cuts the answer into streamed pieces.
 *
 * Given sources (the shared `<source id="Sn">` blocks), it answers with the
 * first sentence of up to two of them, each followed by its marker:
 * "The gauge should read between 1 and 1.5 bar [S1]." Real text from the
 * passage, so citation resolution finds a quote; a real marker, so the stream
 * parser has work. With no sources it says the abstention sentence.
 */
import { parseSources, type ChatMessage } from '@rag/shared';

export const NOT_FOUND = 'Not found in your documents.';
const MAX_WORDS = 30;

/**
 * A scripted answer may cite by content: `[S:Seven years]` becomes the marker
 * of the first source whose text contains "Seven years", so a demo or a spec
 * cites the right document whatever order retrieval packed them in. A needle
 * no source holds is left as written, which the citation parser then drops,
 * the same as a model citing a source it was not given.
 */
export function resolveCites(answer: string, messages: readonly ChatMessage[]): string {
  if (!answer.includes('[S:')) return answer;
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const sources = parseSources(lastUser?.content ?? '');
  return answer.replace(/\[S:([^\]]+)\]/gu, (whole, needle: string) => {
    const source = sources.find((s) => s.text.includes(needle));
    return source === undefined ? whole : `[S${String(source.marker)}]`;
  });
}

/** The first sentence of a passage, skipping markdown headings and blank lines. */
function firstSentence(text: string): string | null {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('#'));
  if (line === undefined) return null;
  const end = /[.!?](?=\s|$)/u.exec(line);
  const sentence = (end === null ? line : line.slice(0, end.index)).split(/\s+/u);
  return sentence.slice(0, MAX_WORDS).join(' ');
}

export function scriptedAnswer(messages: readonly ChatMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const sources = parseSources(lastUser?.content ?? messages.map((m) => m.content).join('\n'));
  const sentences = sources
    .map((s) => ({ marker: s.marker, sentence: firstSentence(s.text) }))
    .filter((s): s is { marker: number; sentence: string } => s.sentence !== null)
    .slice(0, 2)
    .map((s) => `${s.sentence} [S${String(s.marker)}].`);
  return sentences.length === 0 ? NOT_FOUND : sentences.join(' ');
}

/**
 * Pieces of at most three visible characters, each with the whitespace before
 * it, as a tokenizer would cut them: `[S12]` arrives as ` [S1` + `2].`, so a
 * marker split across pieces is the normal case, not an edge case. Joined,
 * the pieces are the answer exactly.
 */
export function streamPieces(answer: string): string[] {
  return answer.match(/\s*\S{1,3}|\s+/gu) ?? [];
}
