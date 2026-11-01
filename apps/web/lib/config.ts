/**
 * Every environment variable this app reads, in one module.
 *
 * All of them are server-only. There is deliberately no `NEXT_PUBLIC_*` name:
 * the browser never calls the API. Server components read through `apiFetch`,
 * server actions write through it, and anything the browser starts goes to this
 * app's own route handlers, which call the API with a service token. So the API has no CORS
 * surface and no service token ever reaches browser JavaScript.
 *
 * Every read is spelled out literally because `scripts/env-contract.mjs` finds
 * reads by pattern and turbo runs in strict env mode: a name it cannot see is a
 * name that is silently stripped from the process.
 */

/** Where the server reaches the API. A service name inside compose, localhost on a laptop. */
export const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:4600';

/** Reported on `/status`, so two builds are tellable apart. */
export const appVersion = process.env.APP_VERSION ?? '0.0.0';

/**
 * The shared HS256 secret.
 *
 * Asserted here rather than where it is used: a missing secret makes every
 * signed-in call fail at once, which presents as an empty library rather than an
 * error. Failing here turns that into one sentence.
 */
export function authSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (secret === undefined || secret.length < 16) {
    throw new Error(
      'AUTH_SECRET must be set and at least 16 characters. Without it the web app cannot mint ' +
        'the service token the API verifies.',
    );
  }
  return secret;
}

/** The site's own origin, for absolute URLs in metadata. Never the API's. */
export const appBaseUrl = process.env.APP_BASE_URL ?? 'http://localhost:3600';
