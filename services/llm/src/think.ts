/**
 * The backup for `think: false` (docs/PLAN.md pipeline step 6): removes every
 * `<think>…</think>` span from text that arrives in pieces, so reasoning a
 * model's template writes into the answer never reaches the reader.
 *
 * Split-invariant: the visible text and the dropped count are the same however
 * the stream is cut, including inside a tag (`<thi` + `nk>`), because a tail
 * that could still become a tag is held back until the next piece decides it.
 * An unclosed `<think>` drops everything after it: half a reasoning trace is
 * still not an answer.
 */
const OPEN = '<think>';
const CLOSE = '</think>';

/** The longest proper prefix of `tag` that `text` ends with. */
function heldTail(text: string, tag: string): number {
  for (let k = Math.min(tag.length - 1, text.length); k > 0; k -= 1) {
    if (text.endsWith(tag.slice(0, k))) return k;
  }
  return 0;
}

const codePoints = (text: string) => Array.from(text).length;

export class ThinkStripper {
  private held = '';
  private inside = false;
  /** Code points of reasoning removed so far. */
  dropped = 0;

  /** Feed the next piece; returns the text that is now certainly visible. */
  push(piece: string): string {
    this.held += piece;
    return this.drain(false);
  }

  /** The stream ended: release what was held. */
  end(): string {
    return this.drain(true);
  }

  private drain(final: boolean): string {
    let visible = '';
    for (;;) {
      const tag = this.inside ? CLOSE : OPEN;
      const at = this.held.indexOf(tag);
      if (at !== -1) {
        const before = this.held.slice(0, at);
        if (this.inside) this.dropped += codePoints(before);
        else visible += before;
        this.held = this.held.slice(at + tag.length);
        this.inside = !this.inside;
        continue;
      }
      const keep = final ? 0 : heldTail(this.held, tag);
      const settled = this.held.slice(0, this.held.length - keep);
      if (this.inside) this.dropped += codePoints(settled);
      else visible += settled;
      this.held = this.held.slice(this.held.length - keep);
      return visible;
    }
  }
}
