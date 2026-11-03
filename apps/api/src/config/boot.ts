/**
 * What must be true before `NestFactory.create` is called.
 *
 * **Every reason this process will not work is discovered before it is
 * listening.** An API that binds :4600 and then fails on the first question looks
 * healthy to a container runtime, gets traffic, and produces a user-facing error
 * for an operational fact that was already true when the process started.
 *
 * Called from `main.ts` before the Nest application exists, so a failure here is
 * a plain sentence on stderr rather than a framework stack with the one useful
 * line buried in the middle of it.
 */
import type { ApiConfig } from './config';

export class BootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootError';
  }
}

/**
 * The JSON body ceiling `main.ts` gives express. The largest JSON body this
 * API accepts is a question (2,000 characters); files arrive as multipart with
 * their own cap (LIMITS.uploadBytes). 64 KB is generous for the first and small
 * enough that a flood of bodies cannot exhaust memory.
 */
export const JSON_BODY_LIMIT_BYTES = 65_536;

export function assertConsistent(config: ApiConfig): void {
  // Sign-in is the credential-stuffing surface, so its budget is deliberately far
  // below the general one. A configuration where auth is the looser of the two
  // is almost certainly a copy-paste, and it is the exact mistake that turns a
  // rate limit into decoration.
  if (config.rateLimitAuth >= config.rateLimitGlobal) {
    throw new BootError(
      `RATE_LIMIT_AUTH (${String(config.rateLimitAuth)}) must be below RATE_LIMIT_GLOBAL ` +
        `(${String(config.rateLimitGlobal)}). Auth is the credential-stuffing surface; a budget ` +
        'at or above the general one is not a limit.',
    );
  }
  // An upload is the most expensive call (20 MiB in memory, then a whole
  // document embedded), so its budget is the tighter one for the same reason.
  if (config.rateLimitUpload >= config.rateLimitGlobal) {
    throw new BootError(
      `RATE_LIMIT_UPLOAD (${String(config.rateLimitUpload)}) must be below RATE_LIMIT_GLOBAL ` +
        `(${String(config.rateLimitGlobal)}). An upload costs a whole document's embeddings; ` +
        'a budget at or above the general one is not a limit.',
    );
  }
}

export function assertBootable(config: ApiConfig): void {
  assertConsistent(config);
}
