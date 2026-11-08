/**
 * An answer's text as a small tree a component renders with plain elements.
 *
 * Never innerHTML (`no-inner-html.test.ts` holds that): the model writes the
 * text, and a document it read can tell it what to write. So the renderer
 * understands a deliberately small markdown subset, the one the prompt's
 * answers use, and everything else stays literal text:
 *
 * - blocks: paragraphs (split on blank lines), `-`/`*` bullets, `1.` items;
 * - inline: `**bold**`, `*em*` / `_em_`, `` `code` ``, and `[Sn]` markers.
 *
 * It runs on every streamed token, so a half-written answer must parse too:
 * an unclosed `**` is literal until its closer arrives, and a marker cut in
 * two (`[S1` + `2]`) is text until it is whole. The stream already delivers
 * markers whole in canonical form; this is the second line of that defence.
 */

export type Inline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'strong'; readonly children: readonly Inline[] }
  | { readonly kind: 'em'; readonly children: readonly Inline[] }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'marker'; readonly marker: number };

export type Block =
  | { readonly kind: 'paragraph'; readonly children: readonly Inline[] }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly Inline[][] };

const BULLET = /^\s{0,3}[-*•]\s+(.*)$/u;
const NUMBERED = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/u;

/** One inline run, left to right, earliest opener first. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer !== '') out.push({ kind: 'text', text: buffer });
    buffer = '';
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const marker = /^\[S(\d{1,2})\]/u.exec(rest);
    if (marker) {
      // A citation sits against the word it cites ("2028¹", not "2028 ¹"):
      // models write a space before the marker, the chip should not show it.
      buffer = buffer.replace(/[ \t]+$/u, '');
      flush();
      out.push({ kind: 'marker', marker: Number(marker[1]) });
      i += marker[0].length;
      continue;
    }
    if (rest.startsWith('`')) {
      const close = rest.indexOf('`', 1);
      if (close > 1) {
        flush();
        out.push({ kind: 'code', text: rest.slice(1, close) });
        i += close + 1;
        continue;
      }
    }
    if (rest.startsWith('**')) {
      const close = rest.indexOf('**', 2);
      if (close > 2) {
        flush();
        out.push({ kind: 'strong', children: parseInline(rest.slice(2, close)) });
        i += close + 2;
        continue;
      }
    }
    const single = rest[0];
    if ((single === '*' || single === '_') && rest[1] !== undefined && rest[1] !== ' ') {
      // `_` only at a word start, so snake_case stays literal.
      const before = text[i - 1];
      const atWordStart = single === '*' || before === undefined || /[\s(]/u.test(before);
      const close = rest.indexOf(single, 1);
      if (atWordStart && close > 1 && rest[close - 1] !== ' ') {
        flush();
        out.push({ kind: 'em', children: parseInline(rest.slice(1, close)) });
        i += close + 1;
        continue;
      }
    }
    buffer += text[i];
    i += 1;
  }
  flush();
  return out;
}

/** The answer as blocks. Line breaks inside a paragraph become spaces. */
export function parseAnswer(answer: string): Block[] {
  const blocks: Block[] = [];
  for (const chunk of answer.replace(/\r\n?/gu, '\n').split(/\n\s*\n/u)) {
    const lines = chunk.split('\n').filter((line) => line.trim() !== '');
    let paragraph: string[] = [];
    let list: { ordered: boolean; items: string[] } | null = null;
    const endParagraph = () => {
      if (paragraph.length > 0)
        blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join(' ').trim()) });
      paragraph = [];
    };
    const endList = () => {
      if (list !== null)
        blocks.push({
          kind: 'list',
          ordered: list.ordered,
          items: list.items.map((item) => parseInline(item.trim())),
        });
      list = null;
    };
    for (const line of lines) {
      const bullet = BULLET.exec(line);
      const numbered = bullet ? null : NUMBERED.exec(line);
      const item = bullet ?? numbered;
      if (item) {
        endParagraph();
        const ordered = numbered !== null;
        if (list === null || list.ordered !== ordered) {
          endList();
          list = { ordered, items: [] };
        }
        list.items.push(item[1]!);
      } else if (list !== null && /^\s{2,}\S/u.test(line)) {
        // An indented line continues the item above it.
        list.items[list.items.length - 1] += ` ${line.trim()}`;
      } else {
        endList();
        paragraph.push(line.trim());
      }
    }
    endParagraph();
    endList();
  }
  return blocks;
}

/** The markers an answer cites, in first-written order, without repeats. */
export function markersIn(answer: string): number[] {
  const seen: number[] = [];
  for (const match of answer.matchAll(/\[S(\d{1,2})\]/gu)) {
    const marker = Number(match[1]);
    if (!seen.includes(marker)) seen.push(marker);
  }
  return seen;
}

/** The answer as a sentence for a screen reader: no markers, no markup characters. */
export function spokenAnswer(text: string): string {
  return text
    .replace(/\s*\[S\d{1,2}\]/gu, '')
    .replace(/[*_`]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}
