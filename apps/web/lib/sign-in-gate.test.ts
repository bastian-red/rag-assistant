import { describe, expect, it } from 'vitest';

import { isPublicPath, signInRedirect } from './sign-in-gate';

describe('the signed-out deep link', () => {
  it('keeps the whole path and query', () => {
    expect(signInRedirect('/chat/cconv0000000000000000000', '?source=3', [])).toBe(
      '/sign-in?next=%2Fchat%2Fcconv0000000000000000000%3Fsource%3D3',
    );
    expect(signInRedirect('/', '', ['other'])).toBe('/sign-in?next=%2F');
  });

  it('lets a request with a session (or a chunked one) through', () => {
    expect(signInRedirect('/', '', ['authjs.session-token'])).toBeNull();
    expect(signInRedirect('/', '', ['__Secure-authjs.session-token.0'])).toBeNull();
  });

  it('protects a page nobody listed, because the default is private', () => {
    for (const path of ['/', '/library', '/chat', '/documents/x', '/a-page-added-next-month']) {
      expect(signInRedirect(path, '', []), path).not.toBeNull();
    }
  });

  it('leaves exactly the public pages alone, and not paths that merely start like them', () => {
    for (const path of ['/sign-in', '/status', '/api/auth/session', '/_next/static/x.js']) {
      expect(isPublicPath(path), path).toBe(true);
    }
    for (const path of ['/sign-in-later', '/statuses', '/api/authx', '/api/documents']) {
      expect(isPublicPath(path), path).toBe(false);
    }
  });
});
