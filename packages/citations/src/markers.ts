/**
 * Citation markers, parsed out of a token stream as it arrives.
 *
 * The model is told to cite as `[S1]`. What it actually writes includes
 * `[S1, S3]`, `[S1; S2]`, `[s2]`, `[S1-S3]` and `[S7]` when only six sources
 * were packed. This turns all of it into one canonical form, one bracket per
 * source (`[S1][S3]`), drops every label that names no packed source and
 * counts it, and passes any other bracketed text (`[note]`, `[1]`) through
 * untouched.
 *
 * Split invariance, the property the stream is built around: whatever way the
 * same answer is cut into deltas, the concatenated output, the cited list and
 * the dropped list are the same. It holds because every decision depends only
 * on the text, never on where a delta ended:
 *
 *  - At a `[`, the verdict depends on the run of marker-shaped characters
 *    after it, up to a `]` or the first character that cannot be part of a
 *    marker. Until that is known the stream holds the prefix (at most
 *    MAX_MARKER_BODY characters; a longer run is plain text).
 *  - Spaces are held until the next character arrives, because a dropped
 *    marker takes the space before it along when punctuation or a space
 *    follows ("as agreed [S9]." becomes "as agreed.").
 */

/** The most characters between the brackets of a marker; a longer run is text. */
export const MAX_MARKER_BODY = 40;

/** A range like S1-S3 expands to at most this many labels. */
export const MAX_RANGE = 10;

export interface DroppedMarker {
  /** The marker as the model wrote it, e.g. "[S7]" or "[S2, S9]". */
  readonly raw: string;
  /** The labels in it that named no packed source. */
  readonly labels: readonly number[];
}

export interface StreamOutput {
  /** Text to show, with markers in canonical form. */
  readonly text: string;
  /** Labels cited for the first time in this output, in order. */
  readonly cited: readonly number[];
}

export interface MarkerStream {
  push(delta: string): StreamOutput;
  /** Flush what is held. The stream accepts nothing after this. */
  end(): StreamOutput;
  /** Every valid label cited so far, in first-use order. */
  cited(): readonly number[];
  /** Every marker, or part of one, that named nothing packed. */
  dropped(): readonly DroppedMarker[];
}

/** The characters a marker body is made of. */
const BODY = /[\sSs0-9,;-]/u;
/** A complete marker: groups of S<n> or S<n>-S<m>, separated by , ; or space. */
const MARKER =
  /^\[\s*[Ss]\d{1,3}(?:\s*-\s*[Ss]?\d{1,3})?(?:\s*[,;]?\s*[Ss]\d{1,3}(?:\s*-\s*[Ss]?\d{1,3})?)*\s*\]$/u;
const GROUP = /[Ss](\d{1,3})(?:\s*-\s*[Ss]?(\d{1,3}))?/gu;
/** After a dropped marker, these swallow the space that came before it. */
const CLOSES = /[\s.,;:!?)\]]/u;

/** The labels a complete marker names, in written order, with ranges expanded. */
export function labelsOf(marker: string): number[] | null {
  if (!MARKER.test(marker)) return null;
  const labels: number[] = [];
  for (const [, from, to] of marker.matchAll(GROUP)) {
    const lo = Number(from);
    const hi = to === undefined ? lo : Number(to);
    if (hi < lo || hi - lo + 1 > MAX_RANGE) return null;
    for (let n = lo; n <= hi; n += 1) labels.push(n);
  }
  return labels;
}

/** Canonical form: one bracket per label, `[S1][S3]`. */
export const canonical = (labels: readonly number[]) => labels.map((n) => `[S${n}]`).join('');

type Verdict =
  { kind: 'hold' } | { kind: 'text' } | { kind: 'marker'; raw: string; labels: number[] };

/** What the `[` at the start of `rest` is, as far as `rest` can tell. */
function judge(rest: string, final: boolean): Verdict {
  let i = 1;
  while (i < rest.length && BODY.test(rest[i]!)) {
    // rest[i] would be body character number i: one too many.
    if (i > MAX_MARKER_BODY) return { kind: 'text' };
    i += 1;
  }
  if (i === rest.length) return final ? { kind: 'text' } : { kind: 'hold' };
  if (rest[i] !== ']') return { kind: 'text' };
  const raw = rest.slice(0, i + 1);
  const labels = labelsOf(raw);
  return labels === null ? { kind: 'text' } : { kind: 'marker', raw, labels };
}

export function createMarkerStream(packed: Iterable<number>): MarkerStream {
  const valid = new Set(packed);
  const cited: number[] = [];
  const dropped: DroppedMarker[] = [];
  let buffer = '';
  /** Spaces waiting for the next character. */
  let spaces = '';
  /** A marker was dropped in full and no visible text has followed yet. */
  let afterDrop = false;
  /** ...and the spaces held from before it have not been replaced yet. */
  let replaceSpaces = false;
  let ended = false;

  const run = (final: boolean): StreamOutput => {
    let out = '';
    const fresh: number[] = [];
    /** Emit visible text, settling the held spaces first. */
    const emit = (text: string) => {
      if (text === '') return;
      if (afterDrop && CLOSES.test(text[0]!)) spaces = '';
      out += spaces + text;
      spaces = '';
      afterDrop = false;
      replaceSpaces = false;
    };

    let i = 0;
    while (i < buffer.length) {
      const character = buffer[i]!;
      if (character === ' ') {
        // After a dropped marker the space that follows it stands in for
        // the one before it: "agreed [S9] and" reads "agreed and".
        if (replaceSpaces) {
          spaces = '';
          replaceSpaces = false;
        }
        spaces += ' ';
        i += 1;
        continue;
      }
      if (character !== '[') {
        // Plain text up to the next space or bracket, in one go.
        let j = i + 1;
        while (j < buffer.length && buffer[j] !== ' ' && buffer[j] !== '[') j += 1;
        emit(buffer.slice(i, j));
        i = j;
        continue;
      }
      // "[", the longest body, and one more character to see past it.
      const verdict = judge(buffer.slice(i, i + MAX_MARKER_BODY + 2), final);
      if (verdict.kind === 'hold') break;
      if (verdict.kind === 'text') {
        emit('[');
        i += 1;
        continue;
      }
      const keep = verdict.labels.filter((n) => valid.has(n));
      const bad = verdict.labels.filter((n) => !valid.has(n));
      if (bad.length > 0) dropped.push({ raw: verdict.raw, labels: bad });
      i += verdict.raw.length;
      if (keep.length === 0) {
        // Dropped in full: the held spaces wait to see what follows.
        afterDrop = true;
        replaceSpaces = true;
        continue;
      }
      const unique = keep.filter((n, k) => keep.indexOf(n) === k);
      for (const n of unique) {
        if (!cited.includes(n)) {
          cited.push(n);
          fresh.push(n);
        }
      }
      emit(canonical(unique));
    }
    buffer = buffer.slice(i);
    if (final) {
      // Trailing spaces survive unless a dropped marker was the last thing.
      if (!afterDrop) out += spaces;
      spaces = '';
    }
    return { text: out, cited: fresh };
  };

  return {
    push(delta) {
      if (ended) throw new Error('marker stream already ended');
      buffer += delta;
      return run(false);
    },
    end() {
      if (ended) throw new Error('marker stream already ended');
      ended = true;
      return run(true);
    },
    cited: () => [...cited],
    dropped: () => [...dropped],
  };
}

/** Run a whole answer through a stream at once. */
export function parseMarkers(answer: string, packed: Iterable<number>) {
  const stream = createMarkerStream(packed);
  const first = stream.push(answer);
  const last = stream.end();
  return { text: first.text + last.text, cited: stream.cited(), dropped: stream.dropped() };
}
