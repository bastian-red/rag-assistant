/**
 * The `text/event-stream` grammar, with no zod behind it.
 *
 * The contracts re-export it (`@rag/shared`), and browser code imports it from
 * `@rag/shared/sse`: the package ships CommonJS, so a client component that took
 * one value from the root would ship every zod contract with it.
 * `sse.test.ts` holds this file import-free.
 */

/** A raw frame as the SSE grammar defines it, before validation. */
export interface SseFrame {
  readonly event: string;
  readonly data: string;
}

/**
 * An incremental parser for the `text/event-stream` grammar (the WHATWG
 * HTML "event stream interpretation" subset this API uses): lines end in
 * LF, CR or CRLF; `event:` names the frame (default `message`); every
 * `data:` line is joined by LF; a line starting with `:` is a comment; a
 * blank line dispatches. One leading space after the colon is dropped.
 *
 * Split invariance: the frames are the same however the stream is cut into
 * pushes, including a CRLF cut between its CR and its LF.
 */
export function createSseParser(): {
  push(text: string): SseFrame[];
  end(): SseFrame[];
} {
  let buffer = '';
  let event = '';
  let data: string[] = [];
  /** The last push ended in CR: an LF at the start of the next is its pair. */
  let pendingCr = false;

  const line = (text: string, out: SseFrame[]) => {
    if (text === '') {
      if (data.length > 0)
        out.push({ event: event === '' ? 'message' : event, data: data.join('\n') });
      event = '';
      data = [];
      return;
    }
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    // id and retry are not used by this API; unknown fields are ignored.
  };

  return {
    push(text) {
      if (pendingCr && text.startsWith('\n')) text = text.slice(1);
      pendingCr = false;
      buffer += text;
      const out: SseFrame[] = [];
      let start = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        const c = buffer[i];
        if (c !== '\n' && c !== '\r') continue;
        line(buffer.slice(start, i), out);
        if (c === '\r') {
          if (i + 1 === buffer.length) pendingCr = true;
          else if (buffer[i + 1] === '\n') i += 1;
        }
        start = i + 1;
      }
      buffer = buffer.slice(start);
      return out;
    },
    end() {
      // A frame without its closing blank line is not dispatched (the spec's rule).
      buffer = '';
      event = '';
      data = [];
      return [];
    },
  };
}
