/**
 * Code-point offsets, the unit every stored offset uses.
 *
 * JavaScript strings index UTF-16 code units; Postgres `char_length` and
 * `substring` count code points. They differ on every character outside the
 * Basic Multilingual Plane (emoji, many CJK extensions, mathematical letters),
 * so a span computed in UTF-16 and checked by the database's
 * `char_length(text) = char_end - char_start` fails on the first emoji.
 * Everything this package returns is in code points; it works in UTF-16
 * internally and converts once, here.
 */

/**
 * A converter from UTF-16 offsets of `text` to code-point offsets. Built once
 * per document (O(n)), each lookup is O(1).
 */
export function codePointOffsets(text: string): (utf16: number) => number {
  // Most text has no astral characters; then the offsets are the same.
  if (!/[\uD800-\uDBFF]/.test(text)) return (utf16) => utf16;
  const map = new Uint32Array(text.length + 1);
  let points = 0;
  for (let i = 0; i < text.length; i += 1) {
    map[i] = points;
    const unit = text.charCodeAt(i);
    // A high surrogate followed by a low one is a single code point.
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        map[i + 1] = points;
        i += 1;
      }
    }
    points += 1;
  }
  map[text.length] = points;
  return (utf16) => map[utf16]!;
}

/** `text` between two code-point offsets (what Postgres `substring` returns). */
export function sliceCodePoints(text: string, start: number, end: number): string {
  return Array.from(text).slice(start, end).join('');
}

/**
 * The inverse of `codePointOffsets`: code-point offsets of `text` to UTF-16
 * offsets, for whoever has to slice a JavaScript string (the viewer, the
 * citation resolver). O(n) to build, O(1) per lookup.
 */
export function utf16Offsets(text: string): (point: number) => number {
  if (!/[\uD800-\uDBFF]/.test(text)) return (point) => point;
  const map: number[] = [];
  let units = 0;
  for (const character of text) {
    map.push(units);
    units += character.length;
  }
  map.push(units);
  return (point) => map[point]!;
}

/** The UTF-16 offset of code point `point` in `text`, for a single lookup. */
export function utf16Offset(text: string, point: number): number {
  let units = 0;
  let seen = 0;
  for (const character of text) {
    if (seen === point) return units;
    units += character.length;
    seen += 1;
  }
  return units;
}
