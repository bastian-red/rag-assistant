import { describe, expect, it } from 'vitest';

import {
  passageBlocks,
  passageFormat,
  quoteSection,
  type Block,
  type Piece,
} from './passage-blocks';

/** The block's text with the mark shown as [[...]], so one string says it all. */
const show = (pieces: readonly Piece[]) =>
  pieces.map((p) => (p.marked ? `[[${p.text}]]` : p.text)).join('');

function outline(blocks: readonly Block[]): string[] {
  return blocks.map((block) => {
    switch (block.kind) {
      case 'heading':
        return `h${String(block.level)} ${show(block.pieces)}`;
      case 'list':
        return `list ${block.items.map(show).join(' | ')}`;
      default:
        return `${block.kind} ${show(block.pieces)}`;
    }
  });
}

/** The span of `quote` in `text`, in code points, as the citation resolver stores it. */
function spanOf(text: string, quote: string) {
  const at = text.indexOf(quote);
  if (at < 0) throw new Error(`"${quote}" is not in the text`);
  const from = Array.from(text.slice(0, at)).length;
  return { from, to: from + Array.from(quote).length };
}

const BOILER = [
  '# Boiler service record',
  '',
  '## Warranty',
  '',
  'The warranty runs for seven years from the installation date, so it ends in',
  'March 2028. It only stays valid if the boiler is serviced every twelve months.',
  '',
  'Parts are covered for the full seven years.',
].join('\n');

describe('passageBlocks, markdown', () => {
  it('sets headings as headings and reflows the hard line breaks of a paragraph', () => {
    expect(outline(passageBlocks(BOILER, 'markdown', null))).toEqual([
      'h1 Boiler service record',
      'h2 Warranty',
      'paragraph The warranty runs for seven years from the installation date, so it ends in March 2028. It only stays valid if the boiler is serviced every twelve months.',
      'paragraph Parts are covered for the full seven years.',
    ]);
  });

  it('marks exactly the quoted characters, across the reflowed line break', () => {
    const quote = 'so it ends in\nMarch 2028.';
    expect(outline(passageBlocks(BOILER, 'markdown', spanOf(BOILER, quote)))[2]).toBe(
      'paragraph The warranty runs for seven years from the installation date, [[so it ends in March 2028.]] It only stays valid if the boiler is serviced every twelve months.',
    );
  });

  it('cuts a mark that crosses two blocks into one piece per block', () => {
    const quote = 'twelve months.\n\nParts are covered';
    const blocks = outline(passageBlocks(BOILER, 'markdown', spanOf(BOILER, quote)));
    expect(blocks[2]).toMatch(/\[\[twelve months\.\]\]$/u);
    expect(blocks[3]).toBe('paragraph [[Parts are covered]] for the full seven years.');
  });

  it('keeps a table and a fence as set, and drops only a bullet, never a number', () => {
    const text = [
      '| Date | Notes |',
      '| --- | --- |',
      '| 9 Oct | Flue seal |',
      '',
      '- Bleed upstairs first.',
      '- Then downstairs,',
      '  with the heating off.',
      '',
      '1. Open the valve.',
      '',
      '```',
      'F22  low pressure',
      '```',
    ].join('\n');
    expect(outline(passageBlocks(text, 'markdown', spanOf(text, 'Flue seal')))).toEqual([
      'table | Date | Notes |\n| --- | --- |\n| 9 Oct | [[Flue seal]] |',
      'list Bleed upstairs first. | Then downstairs, with the heating off. | 1. Open the valve.',
      'code ```\nF22  low pressure\n```',
    ]);
  });

  it('keeps the mark on the words of a heading, not on its hashes', () => {
    const text = '## Pressure\n\nThe gauge reads 1.3 bar.';
    expect(outline(passageBlocks(text, 'markdown', spanOf(text, '## Pressure')))[0]).toBe(
      'h2 [[Pressure]]',
    );
  });

  it('counts the span in code points: an emoji before the quote does not shift it', () => {
    const text = 'Keep the key 🔑 in the drawer. Bleed the radiators in autumn.';
    const span = spanOf(text, 'Bleed the radiators in autumn.');
    // The emoji is two UTF-16 units and one code point.
    expect(span.from).toBe(text.indexOf('Bleed') - 1);
    expect(outline(passageBlocks(text, 'markdown', span))).toEqual([
      'paragraph Keep the key 🔑 in the drawer. [[Bleed the radiators in autumn.]]',
    ]);
  });
});

describe('passageBlocks, PDF and text', () => {
  it('promotes nothing to a heading: a short line stays text', () => {
    const text = 'Radiators\n\nBleed the radiators every autumn,\nupstairs first.';
    expect(outline(passageBlocks(text, 'text', null))).toEqual([
      'paragraph Radiators',
      'paragraph Bleed the radiators every autumn, upstairs first.',
    ]);
  });

  it('leaves a markdown-looking line alone in a text file', () => {
    expect(outline(passageBlocks('# not a heading here.', 'text', null))).toEqual([
      'paragraph # not a heading here.',
    ]);
  });
});

describe('passageFormat', () => {
  it('reads markup only in markdown', () => {
    expect(passageFormat('text/markdown')).toBe('markdown');
    expect(passageFormat('application/pdf')).toBe('text');
    expect(passageFormat('text/plain')).toBe('text');
  });
});

describe('quoteSection', () => {
  const chunk = {
    text: '## Warranty\n\nSeven years from March 2021.\n\n## Annual service\n\nBooked for October.',
    headingPath: ['Boiler service record'],
  };
  const at = (quote: string) => Array.from(chunk.text.slice(0, chunk.text.indexOf(quote))).length;

  it('names the heading the quote sits under, not the one the passage started under', () => {
    expect(quoteSection(chunk, 'markdown', at('Seven years'))).toBe('Warranty');
    expect(quoteSection(chunk, 'markdown', at('Booked for'))).toBe('Annual service');
  });

  it('falls back to the passage heading path before the first heading, and outside markdown', () => {
    const plain = { text: 'Opening line. ## Not a heading', headingPath: ['Radiators'] };
    expect(quoteSection(plain, 'text', 0)).toBe('Radiators');
    expect(quoteSection({ text: 'Lead.\n\n## Later', headingPath: [] }, 'markdown', 0)).toBeNull();
  });
});
