import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { TOKEN_WEIGHTS, TokenMeter, estimateTokens } from './tokens';

/** True counts from the embedding model (scripts/calibrate-tokens.mjs). */
interface Calibration {
  readonly model: string;
  readonly overhead: number;
  readonly samples: readonly { readonly text: string; readonly tokens: number }[];
}

const calibration = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'token-counts.json'), 'utf8'),
) as Calibration;

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** The same estimate written the obvious way, as an oracle for the meter. */
function reference(text: string): number {
  const count = (pattern: RegExp) => text.match(pattern)?.length ?? 0;
  const words = text.match(/\p{L}+/gu) ?? [];
  const w = TOKEN_WEIGHTS;
  const raw =
    count(/\p{Nd}/gu) * w.digit +
    words.length * w.word +
    words.join('').length * w.letter +
    count(/[^\p{L}\p{Nd}\s]/gu) * w.punctuation +
    Array.from(text).filter((c) => c.codePointAt(0)! > 0x7f).length * w.nonAscii;
  return Math.ceil(Math.round(raw * w.safety * 1e6) / 1e6);
}

describe('estimateTokens against the measured counts', () => {
  const passages = calibration.samples.filter((sample) => sample.tokens >= 20);
  const ratios = passages.map((sample) => estimateTokens(sample.text) / sample.tokens);

  it('was calibrated on the embedding model with a real sample', () => {
    expect(calibration.model).toBe('qwen3-embedding:0.6b');
    expect(calibration.samples.length).toBeGreaterThanOrEqual(60);
    expect(passages.length).toBeGreaterThanOrEqual(40);
  });

  it('never undercounts a passage by more than 15 percent', () => {
    const worst = Math.min(...ratios);
    expect(worst).toBeGreaterThanOrEqual(0.85);
  });

  it('errs high by a modest margin on the typical passage', () => {
    const typical = median(ratios);
    expect(typical).toBeGreaterThanOrEqual(1.05);
    expect(typical).toBeLessThanOrEqual(1.35);
  });

  it('errs high over the whole sample, never wildly', () => {
    const estimated = calibration.samples.reduce((sum, s) => sum + estimateTokens(s.text), 0);
    const measured = calibration.samples.reduce((sum, s) => sum + s.tokens, 0);
    expect(estimated / measured).toBeGreaterThanOrEqual(1.0);
    expect(estimated / measured).toBeLessThanOrEqual(1.35);
  });

  it('beats chars/4 on the passages it was fitted for', () => {
    const quarter = passages.map((s) => Math.ceil(s.text.length / 4) / s.tokens);
    expect(Math.min(...ratios)).toBeGreaterThan(Math.min(...quarter));
  });

  it('counts digits one by one, as the tokenizer does', () => {
    const digits = calibration.samples.find((s) => /IBAN/u.test(s.text));
    expect(digits).toBeDefined();
    expect(estimateTokens(digits!.text)).toBeGreaterThanOrEqual(digits!.tokens);
    expect(Math.ceil(digits!.text.length / 4)).toBeLessThan(digits!.tokens);
  });
});

describe('TokenMeter', () => {
  const text = fc.string({
    unit: fc.oneof(
      fc.constantFrom('a', 'Z', 'é', '7', '٣', ' ', '\n', '.', ',', '-', '€', '°', 'ß', '中'),
      fc.constant(String.fromCodePoint(0x1f642)),
      fc.constant(String.fromCodePoint(0x0301)),
      fc.constant(String.fromCodePoint(0x00a0)),
    ),
    maxLength: 200,
  });

  it('equals the regex definition on any text', () => {
    fc.assert(fc.property(text, (t) => estimateTokens(t) === reference(t)));
  });

  it('reads, after any prefix, the estimate of that prefix', () => {
    fc.assert(
      fc.property(text, (t) => {
        const meter = new TokenMeter();
        let prefix = '';
        for (const character of t) {
          meter.add(character);
          prefix += character;
          if (meter.tokens !== estimateTokens(prefix)) return false;
        }
        return true;
      }),
    );
  });

  it('is additive over whitespace, within the rounding of each part', () => {
    fc.assert(
      fc.property(text, text, (a, b) => {
        const whole = estimateTokens(`${a} ${b}`);
        return whole <= estimateTokens(a) + estimateTokens(b);
      }),
    );
  });

  it('costs nothing for whitespace and something for every visible character', () => {
    expect(estimateTokens(' \n  \n')).toBe(0);
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBeGreaterThan(0);
    expect(estimateTokens('.')).toBeGreaterThan(0);
  });
});
