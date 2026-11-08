/**
 * `POST /api/documents`: an upload, streamed straight through to the API.
 *
 * The body is never read here. The API enforces the size cap, the accepted
 * types (by magic bytes) and the upload budget, and a body buffered in this
 * process would cost memory for a file the API is about to refuse.
 */
import { LIMITS } from '@rag/shared';

import { linkedAbort, problem, relayJson, sessionUser, upstream } from '../../../lib/upstream';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const user = await sessionUser();
  if (user === null) return problem(401, 'UNAUTHENTICATED', 'Sign in to upload.');
  const type = request.headers.get('content-type') ?? '';
  if (!type.startsWith('multipart/form-data')) {
    return problem(400, 'INVALID', 'Send the file as a multipart form.');
  }
  // A declared length over the cap (plus room for the form's own fields) is
  // refused before a byte is forwarded.
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > LIMITS.uploadBytes + 64 * 1024) {
    return problem(
      413,
      'TOO_LARGE',
      `That file is larger than ${String(LIMITS.uploadBytes / 1024 / 1024)} MB.`,
    );
  }
  const abort = linkedAbort(request);
  try {
    const response = await upstream(user, '/documents', {
      method: 'POST',
      body: request.body,
      headers: {
        'content-type': type,
        ...(length > 0 ? { 'content-length': String(length) } : {}),
      },
      signal: abort.signal,
    });
    return await relayJson(response);
  } catch (error) {
    if (abort.signal.aborted) return problem(499, 'CANCELLED', 'The upload was cancelled.');
    console.error('[web] upload could not reach the API:', error);
    return problem(502, 'UNAVAILABLE', 'The library is not reachable right now. Try again.');
  }
}
