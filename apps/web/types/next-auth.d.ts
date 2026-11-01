/**
 * The session shape, taught to Auth.js.
 *
 * Auth.js types `session.user` as `{ name?, email?, image? }`, which has none of
 * what this app needs: the id every document is owned by. `SessionUser` is the
 * contract from `@rag/shared`, so this cannot drift from what `auth.ts` parses
 * into the token.
 */
import type { SessionUser } from '@rag/shared';

declare module 'next-auth' {
  interface Session {
    user: SessionUser;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    /** Namespaced, so it cannot collide with a claim Auth.js owns. */
    rag?: SessionUser;
  }
}
