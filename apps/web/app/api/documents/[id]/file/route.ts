/**
 * `GET /api/documents/:id/file`: the original bytes, for "Open the original".
 *
 * The API's safety headers are passed on unchanged: `nosniff`, and a
 * sandbox CSP so an uploaded file can never run script on this origin.
 * Measured on 2026-11-07: Chromium's PDF viewer renders a PDF served under
 * that sandbox and honours `#page=N`, so the sandbox costs the viewer nothing.
 */
import { linkedAbort, pathId, problem, sessionUser, upstream } from '../../../../../lib/upstream';

export const dynamic = 'force-dynamic';

const PASSED = [
  'content-type',
  'content-length',
  'content-disposition',
  'x-content-type-options',
  'content-security-policy',
] as const;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await sessionUser();
  if (user === null) return problem(401, 'UNAUTHENTICATED', 'Sign in to open your documents.');
  const id = pathId((await params).id);
  if (id === null) return problem(404, 'NOT_FOUND', 'No such document.');
  const abort = linkedAbort(request);
  const response = await upstream(user, `/documents/${id}/file`, { signal: abort.signal });
  if (!response.ok || response.body === null) {
    return problem(response.status === 404 ? 404 : 502, 'NOT_FOUND', 'That file is not available.');
  }
  const headers = new Headers({ 'cache-control': 'private, no-store' });
  for (const name of PASSED) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(response.body, { status: 200, headers });
}
