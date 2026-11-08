/**
 * Every colour pair this app paints, against WCAG AA, in both schemes, parsed
 * from the real stylesheet. Never from a copy of the palette: a table of hexes
 * in TypeScript would pass forever while the CSS said something else.
 *
 * The reference desk palette (docs/DESIGN.md). `--rule` is the one token not
 * listed: a hairline between regions, never the edge of a control, so it has
 * no contrast floor (WCAG 1.4.11 covers what is needed to identify a control).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AA_NORMAL,
  AA_UI,
  extractTokens,
  greyscale,
  ratio,
  resolve,
  stripCssComments,
} from './contrast';

const css = stripCssComments(readFileSync(join(__dirname, '..', 'app', 'globals.css'), 'utf8'));
const light = extractTokens(css, ':root');
const dark = {
  ...light,
  ...extractTokens(css.slice(css.indexOf('@media (prefers-color-scheme: dark)')), ':root'),
};
const SCHEMES = { light, dark } as const;

const BACKGROUNDS = ['--bg', '--surface'] as const;
const TEXT = ['--text', '--muted', '--accent', '--danger', '--ok'] as const;

describe('text clears AA everywhere it is painted', () => {
  for (const [name, palette] of Object.entries(SCHEMES)) {
    for (const foreground of TEXT) {
      for (const background of BACKGROUNDS) {
        it(`${name}: ${foreground} on ${background}`, () => {
          const value = ratio(resolve(palette, foreground), resolve(palette, background));
          expect(
            value,
            `${foreground} on ${background} is ${String(value)}:1`,
          ).toBeGreaterThanOrEqual(AA_NORMAL);
        });
      }
    }
    it(`${name}: --text on --mark (the quoted words, a hovered citation, a drop target)`, () => {
      expect(ratio(resolve(palette, '--text'), resolve(palette, '--mark'))).toBeGreaterThanOrEqual(
        AA_NORMAL,
      );
    });
    it(`${name}: --accent-ink on --accent (the primary button)`, () => {
      expect(
        ratio(resolve(palette, '--accent-ink'), resolve(palette, '--accent')),
      ).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  }
});

describe('control edges and the focus ring clear 3:1', () => {
  for (const [name, palette] of Object.entries(SCHEMES)) {
    for (const mark of ['--border', '--accent'] as const) {
      for (const background of BACKGROUNDS) {
        it(`${name}: ${mark} on ${background}`, () => {
          expect(
            ratio(resolve(palette, mark), resolve(palette, background)),
          ).toBeGreaterThanOrEqual(AA_UI);
        });
      }
    }
  }
});

describe('colour is never the only channel', () => {
  for (const [name, palette] of Object.entries(SCHEMES)) {
    it(`${name}: ok and danger are close in greyscale, so status words carry a glyph`, () => {
      const ok = greyscale(resolve(palette, '--ok'));
      const danger = greyscale(resolve(palette, '--danger'));
      expect(ratio(ok, danger)).toBeLessThan(1.6);
    });
  }
});

describe('the dark scheme is really parsed', () => {
  it('overrides the canvas, so the dark half of this file is not testing light twice', () => {
    expect(resolve(dark, '--bg')).not.toBe(resolve(light, '--bg'));
  });
});
