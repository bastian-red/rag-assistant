/**
 * How retrieved passages are written into a prompt, and read back out of one.
 *
 * The prompt builder (build step 7) writes them; the fake model server reads
 * them to answer with real citations; the eval lane reads them to check what
 * the model was shown. One format, one place, so the three cannot drift.
 *
 *     <source id="S1">
 *     title: Boiler manual
 *     page: 3
 *     ---
 *     The gauge should read between 1 and 1.5 bar when the system is cold.
 *     </source>
 *
 * A passage is DATA, not instructions (the SPECS hostile-document case), so
 * its text can never close its own fence or open a new one: any `<source` or
 * `</source` inside a title or a passage is written as `&lt;source`, and a
 * literal `&lt;source` already in the text gains one more `amp;`, so reading
 * a block back always gives the exact text that was written. `page` is
 * omitted for markdown and text, which have no pages. A title is one line:
 * its whitespace runs collapse to one space.
 */

export interface SourceBlock {
  /** The `[S<marker>]` label the model cites. 1-999. */
  readonly marker: number;
  readonly title: string;
  readonly page: number | null;
  readonly text: string;
}

// `<source` / `</source` (any case) as a whole word, raw or already escaped.
const ESCAPABLE = /(&(?:amp;)*lt;|<)(?=\/?source\b)/giu;
const ESCAPED = /&((?:amp;)*)lt;(?=\/?source\b)/giu;
const BLOCK =
  /<source id="S(\d{1,3})">\ntitle: ([^\n]*)\n(?:page: (\d{1,6})\n)?---\n([\s\S]*?)\n<\/source>/gu;

/** Escape every tag-like `<source` so a text cannot break out of its block. */
export function fenceText(text: string): string {
  return text.replace(ESCAPABLE, (match: string) =>
    match === '<' ? '&lt;' : `&amp;${match.slice(1)}`,
  );
}

/** The exact inverse of `fenceText`. */
export function unfenceText(text: string): string {
  return text.replace(ESCAPED, (_match: string, amps: string) =>
    amps === '' ? '<' : `&${amps.slice('amp;'.length)}lt;`,
  );
}

/** A title as it is written: one line. */
export function sourceTitle(title: string): string {
  return title.replace(/\s+/gu, ' ').trim();
}

export function formatSource(source: SourceBlock): string {
  if (!Number.isInteger(source.marker) || source.marker < 1 || source.marker > 999) {
    throw new RangeError(`a source marker is 1-999, got ${String(source.marker)}`);
  }
  if (source.page !== null && (!Number.isInteger(source.page) || source.page < 1)) {
    throw new RangeError(`a page is a positive integer, got ${String(source.page)}`);
  }
  const page = source.page === null ? '' : `page: ${String(source.page)}\n`;
  return (
    `<source id="S${String(source.marker)}">\n` +
    `title: ${fenceText(sourceTitle(source.title))}\n` +
    `${page}---\n${fenceText(source.text)}\n</source>`
  );
}

/** Blocks separated by a blank line, in the order given. */
export function formatSources(sources: readonly SourceBlock[]): string {
  return sources.map(formatSource).join('\n\n');
}

/** Every block in a prompt, in order. Text outside blocks is ignored. */
export function parseSources(prompt: string): SourceBlock[] {
  return [...prompt.matchAll(BLOCK)].map((match) => ({
    marker: Number(match[1]),
    title: unfenceText(match[2] ?? ''),
    page: match[3] === undefined ? null : Number(match[3]),
    text: unfenceText(match[4] ?? ''),
  }));
}
