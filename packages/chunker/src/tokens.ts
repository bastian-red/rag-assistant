/**
 * How many qwen3 tokens a passage costs, without the tokenizer.
 *
 * The exact tokenizer is a large dependency, and nothing here needs an exact
 * count: the chunker aims at ~400 tokens and the context packer (build step
 * 6) must not overrun the model's window. What both need is an estimate that
 * is rarely under the truth and never far under it.
 *
 * `chars / 4`, the usual rule, is wrong for this tokenizer in the direction
 * that hurts: Qwen splits numbers into one token per digit, so an invoice line
 * of 76 characters is 62 tokens, and ceil(chars/4) undercounts 18 of 72
 * measured samples, the worst at 0.31 of the true count. This is a least-squares fit over character
 * classes on those samples (true counts from the model server, see
 * scripts/calibrate-tokens.mjs and src/fixtures/token-counts.json), rounded,
 * then scaled by 1.2 so it errs high. `tokens.test.ts` holds it to the
 * measured counts.
 *
 * The count is a running meter rather than a handful of regexes so the
 * chunker can split an oversize passage in one pass: whitespace costs
 * nothing and never joins two words, so the meter's reading after any prefix
 * is exactly the estimate of that prefix.
 */

/** The fitted weights, per character class (see the header). */
export const TOKEN_WEIGHTS = Object.freeze({
  digit: 1.3,
  word: 0.8,
  letter: 0.075,
  punctuation: 0.5,
  nonAscii: 1.65,
  safety: 1.2,
});

const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;
const SPACE = /\s/u;

/** A running estimate over code points fed in order. */
export class TokenMeter {
  private raw = 0;
  private inWord = false;

  /** Feed one code point (one element of `Array.from(text)`). */
  add(character: string): void {
    const w = TOKEN_WEIGHTS;
    if (LETTER.test(character)) {
      if (!this.inWord) this.raw += w.word;
      this.raw += w.letter;
      this.inWord = true;
    } else {
      this.inWord = false;
      if (DIGIT.test(character)) this.raw += w.digit;
      else if (!SPACE.test(character)) this.raw += w.punctuation;
    }
    if (character.codePointAt(0)! > 0x7f) this.raw += w.nonAscii;
  }

  /** The estimate of everything fed so far. */
  get tokens(): number {
    // Rounded first so that 0.1 + 0.2 style float error never adds a token.
    return Math.ceil(Math.round(this.raw * TOKEN_WEIGHTS.safety * 1e6) / 1e6);
  }
}

export function estimateTokens(text: string): number {
  const meter = new TokenMeter();
  for (const character of text) meter.add(character);
  return meter.tokens;
}
