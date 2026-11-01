/**
 * fast-check generators for this package's property tests. Lives outside
 * `src/` so it never compiles into `dist/` (it imports a devDependency);
 * `tsconfig.test.json` typechecks it with the tests.
 */
import fc from 'fast-check';

const ch = (code: number) => String.fromCodePoint(code);

/** Characters a real upload throws at the normaliser. */
const awkward = fc.constantFrom(
  '\r\n',
  '\r',
  '\t',
  ch(0x00a0), // no-break space
  ch(0x2009), // thin space
  ch(0x3000), // ideographic space
  ch(0x200b), // zero-width space
  ch(0x00ad), // soft hyphen
  ch(0xfeff), // byte-order mark mid-text
  ch(0x07), // bell
  ch(0x0301), // combining acute
  ch(0x1f642), // emoji, outside the BMP
  ch(0x1d400), // mathematical bold A, outside the BMP
);

const word = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.constantFrom(
      'boiler',
      'pressure',
      'deposit',
      'the',
      'is',
      'café',
      'Größe',
      '1.5',
      '2026',
      'e.g.',
      'Dr.',
      'Mr.',
      'bar',
      'F22',
      'naïve',
    ),
  },
  { weight: 1, arbitrary: fc.stringMatching(/^[a-z]{1,12}$/u) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 99999 }).map(String) },
  // A word too long for any chunk (over 400 tokens): a pasted hash or blob.
  { weight: 1, arbitrary: fc.integer({ min: 160, max: 400 }).map((n) => 'x7'.repeat(n)) },
);

const sentence = fc
  .tuple(fc.array(word, { minLength: 1, maxLength: 30 }), fc.constantFrom('.', '!', '?', ''))
  .map(([words, end]) => {
    const body = words.join(' ');
    return body.charAt(0).toUpperCase() + body.slice(1) + end;
  });

/** A paragraph, sometimes hard-wrapped like a PDF line. */
const paragraph = fc
  .array(sentence, { minLength: 1, maxLength: 8 })
  .chain((sentences) => fc.boolean().map((wrap) => sentences.join(wrap ? '\n' : ' ')));

const heading = fc
  .tuple(
    fc.integer({ min: 1, max: 4 }),
    fc.array(
      word.filter((w) => w.length < 20),
      { minLength: 1, maxLength: 5 },
    ),
  )
  .map(([level, words]) => `${'#'.repeat(level)} ${words.join(' ')}`);

const list = fc
  .array(sentence, { minLength: 1, maxLength: 5 })
  .chain((items) =>
    fc.constantFrom('-', '*', '1.').map((m) => items.map((i) => `${m} ${i}`).join('\n')),
  );

const table = fc
  .array(fc.tuple(word, word), { minLength: 1, maxLength: 6 })
  .map((rows) => ['| a | b |', '|---|---|', ...rows.map(([a, b]) => `| ${a} | ${b} |`)].join('\n'));

const fence = fc
  .array(fc.stringMatching(/^[a-z =();]{0,40}$/u), { minLength: 0, maxLength: 6 })
  .map((lines) => ['```', ...lines, '```'].join('\n'));

/** A markdown (or markdown-shaped plain text) document. */
export const document = fc
  .array(fc.oneof({ weight: 6, arbitrary: paragraph }, heading, list, table, fence), {
    maxLength: 24,
  })
  .chain((blocks) =>
    fc
      .array(fc.constantFrom('\n\n', '\n\n\n\n', '\r\n\r\n', '\n \n'), {
        minLength: blocks.length,
        maxLength: blocks.length,
      })
      .map((gaps) => blocks.map((block, i) => block + gaps[i]!).join('')),
  );

/** A document with awkward characters sprinkled through it. */
export const messyText = fc
  .tuple(document, fc.array(fc.tuple(fc.nat(), awkward), { maxLength: 12 }))
  .map(([text, inserts]) => {
    let out = text;
    for (const [at, character] of inserts) {
      // Never inside a surrogate pair, which would make a lone surrogate.
      let i = out.length === 0 ? 0 : at % (out.length + 1);
      const unit = out.charCodeAt(i);
      if (i > 0 && i < out.length && unit >= 0xdc00 && unit <= 0xdfff) i -= 1;
      out = out.slice(0, i) + character + out.slice(i);
    }
    return out;
  });
