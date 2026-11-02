/**
 * Lines of a newline-delimited JSON body, as Ollama streams `/api/chat`.
 * A line split across network reads is joined; blank lines are skipped; a
 * final line with no newline is still a line. Decoding is streaming UTF-8, so
 * a character split across reads is not mangled.
 */
export async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const reader = body.getReader();
  let pending = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line !== '') yield line;
        newline = pending.indexOf('\n');
      }
    }
    pending += decoder.decode();
    if (pending.trim() !== '') yield pending.trim();
  } finally {
    // Cancels the body when the consumer stops early, so the request closes.
    await reader.cancel().catch(() => undefined);
  }
}
