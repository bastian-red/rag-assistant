/**
 * Where a signed-out request for a private page is sent: sign-in, with the
 * WHOLE path and query as `next`.
 *
 * **Private by default.** Every page here shows somebody's own library, so
 * the list is of what is PUBLIC (sign-in, sign-up, the status page, Auth.js's own
 * routes), and a page added next month is protected unless someone adds it
 * here on purpose. The opposite arrangement fails open in the direction that
 * matters.
 *
 * Why this lives in the proxy and not in a layout: a layout runs before its
 * page and does not know the URL it is rendering, so a deep link to one
 * conversation would come back to the library instead. A sibling project's
 * E2E suite caught exactly that.
 *
 * Cookie PRESENCE only. Verifying the session is the pages' job (and the
 * API's, on every call); this only decides where a request with no session at
 * all should go first.
 */
export const SESSION_COOKIES = ['authjs.session-token', '__Secure-authjs.session-token'] as const;

/** Exact public paths, and public prefixes (which must end in `/`). */
const PUBLIC_PATHS = new Set([
  '/sign-in',
  '/sign-up',
  '/status',
  '/icon.svg',
  '/favicon.ico',
  '/robots.txt',
]);
const PUBLIC_PREFIXES = ['/api/auth/', '/_next/'];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * Route handlers under `/api/` answer a signed-out call with a 401 of their
 * own (`lib/upstream.ts`): a fetch that followed a redirect here would get the
 * sign-in page's HTML with a 200 and read it as an answer.
 */
export function answersForItself(pathname: string): boolean {
  return pathname.startsWith('/api/');
}

export function signInRedirect(
  pathname: string,
  search: string,
  cookieNames: readonly string[],
): string | null {
  if (isPublicPath(pathname) || answersForItself(pathname)) return null;
  // Auth.js splits a large session into chunks: authjs.session-token.0, .1, ...
  const signedIn = cookieNames.some((name) =>
    SESSION_COOKIES.some((c) => name === c || name.startsWith(`${c}.`)),
  );
  if (signedIn) return null;
  return `/sign-in?next=${encodeURIComponent(`${pathname}${search}`)}`;
}
