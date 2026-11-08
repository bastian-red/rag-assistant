/**
 * `POST /api/chat/:conversationId`: ask, and read the answer as it streams.
 *
 * A refusal before the stream (400, 404, 409 one answer at a time, 429) is
 * relayed as the API's JSON. After that only stream events arrive, each
 * validated here. Stop is the browser aborting this request: see
 * `lib/upstream.ts` for how that reaches the API.
 */
import {
  linkedAbort,
  pathId,
  problem,
  relayChat,
  relayJson,
  sessionUser,
  upstream,
} from '../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/** A question of LIMITS.question characters, JSON-escaped, fits with room to spare. */
const MAX_BODY = 16 * 1024;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
): Promise<Response> {
  const user = await sessionUser();
  if (user === null) return problem(401, 'UNAUTHENTICATED', 'Sign in to ask.');
  const id = pathId((await params).conversationId);
  if (id === null) return problem(404, 'NOT_FOUND', 'No such conversation.');
  // A declared length is refused before a byte is read; one without (chunked)
  // is checked after, and the API holds the question to LIMITS.question.
  if (Number(request.headers.get('content-length') ?? '0') > MAX_BODY) {
    return problem(413, 'TOO_LARGE', 'That question is too long.');
  }
  const body = await request.text();
  if (body.length > MAX_BODY) return problem(413, 'TOO_LARGE', 'That question is too long.');
  const abort = linkedAbort(request);
  try {
    const response = await upstream(user, `/chat/${id}/messages`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      signal: abort.signal,
    });
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || response.body === null || !type.startsWith('text/event-stream')) {
      return await relayJson(response);
    }
    return relayChat(response, abort);
  } catch {
    if (abort.signal.aborted) return problem(499, 'CANCELLED', 'Stopped.');
    return problem(502, 'UNAVAILABLE', 'The assistant is not reachable right now. Try again.');
  }
}
