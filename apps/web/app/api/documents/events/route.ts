/**
 * `GET /api/documents/events`: the signed-in person's ingest events, live.
 * The API's channel is per owner, so this feed cannot carry anyone else's
 * documents whatever the page does with it.
 */
import {
  linkedAbort,
  problem,
  relayIngest,
  relayJson,
  sessionUser,
  upstream,
} from '../../../../lib/upstream';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const user = await sessionUser();
  if (user === null) return problem(401, 'UNAUTHENTICATED', 'Sign in to follow your documents.');
  const abort = linkedAbort(request);
  try {
    const response = await upstream(user, '/documents/events', {
      headers: { accept: 'text/event-stream' },
      signal: abort.signal,
    });
    if (!response.ok || response.body === null) return await relayJson(response);
    return relayIngest(response, abort);
  } catch {
    return problem(502, 'UNAVAILABLE', 'Live status is not reachable right now.');
  }
}
