/**
 * Where an uploaded file lives: `<UPLOAD_DIR>/<ownerId>/<sha256>`.
 *
 * Content-addressed and per owner. The path is derived, never stored, so the
 * row (`documents.owner_id`, `documents.sha256`) is the only record of it, and
 * the `(owner_id, sha256)` unique key makes it one file per document. Two
 * people uploading the same bytes get two files: sharing one would make
 * deleting a document depend on someone else's library.
 *
 * Both parts are validated before they touch a path, so neither can climb out
 * of the directory (`../`), and the directory must be absolute: a relative one
 * resolves against each process's own working directory, and the API and the
 * worker run from different ones.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const OWNER = /^[a-z0-9]{20,40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export function storedFilePath(uploadDir: string, ownerId: string, sha256: string): string {
  if (!isAbsolute(uploadDir))
    throw new Error(`UPLOAD_DIR must be an absolute path, got ${uploadDir}`);
  if (!OWNER.test(ownerId)) throw new Error('not an owner id');
  if (!SHA256.test(sha256)) throw new Error('not a sha256');
  return join(uploadDir, ownerId, sha256);
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Write atomically: a temporary name in the same directory, then a rename, so
 * a reader (the worker) never sees half a file, and a crash leaves at worst a
 * stray `.tmp-*` and never a truncated document under its real name.
 */
export async function writeStoredFile(
  uploadDir: string,
  ownerId: string,
  bytes: Uint8Array,
): Promise<{ path: string; sha256: string }> {
  const sha256 = sha256Of(bytes);
  const path = storedFilePath(uploadDir, ownerId, sha256);
  await mkdir(join(uploadDir, ownerId), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { path, sha256 };
}

/**
 * Where an upload streams to before it is judged: `<UPLOAD_DIR>/.incoming/`.
 * Inside UPLOAD_DIR, so adopting it is a rename on one filesystem (atomic),
 * never a copy. The dot keeps it out of the owner-id namespace.
 */
export const INCOMING_DIR = '.incoming';

export async function incomingFilePath(uploadDir: string): Promise<string> {
  if (!isAbsolute(uploadDir))
    throw new Error(`UPLOAD_DIR must be an absolute path, got ${uploadDir}`);
  const dir = join(uploadDir, INCOMING_DIR);
  await mkdir(dir, { recursive: true });
  return join(dir, randomUUID());
}

/**
 * Moves a judged upload to its stored name. A rename replaces atomically, so
 * a second upload of the same bytes swaps in an identical file under the
 * worker's feet, which is harmless.
 */
export async function adoptIncomingFile(
  incoming: string,
  uploadDir: string,
  ownerId: string,
  sha256: string,
): Promise<string> {
  const path = storedFilePath(uploadDir, ownerId, sha256);
  await mkdir(join(uploadDir, ownerId), { recursive: true });
  await rename(incoming, path);
  return path;
}

export interface UploadSweep {
  /** Stored files whose (owner, sha256) has no document row. */
  readonly orphans: number;
  /** `.incoming/*` and `*.tmp-*` left by a crash or a cut connection. */
  readonly partials: number;
  /** Files looked at. */
  readonly scanned: number;
}

/**
 * Removes what no row accounts for, once it is older than `graceMs`.
 *
 * A file can outlive its row's absence in three ways, none of which the
 * request that wrote it can clean up: the process dies between the rename and
 * the insert, the insert fails for a reason other than a duplicate, or the
 * connection drops mid-stream after multer stopped watching. The grace (10
 * minutes by default, uploads take milliseconds between write and insert)
 * keeps a sweep from deleting a file whose row is being written right now.
 * `known(ownerId, shas)` answers which of those sha256s have a row; it is
 * the only thing the sweep asks the database.
 */
export async function sweepUploads(
  uploadDir: string,
  known: (ownerId: string, sha256s: readonly string[]) => Promise<ReadonlySet<string>>,
  { graceMs = 10 * 60_000, now = Date.now() }: { graceMs?: number; now?: number } = {},
): Promise<UploadSweep> {
  if (!isAbsolute(uploadDir))
    throw new Error(`UPLOAD_DIR must be an absolute path, got ${uploadDir}`);
  let orphans = 0;
  let partials = 0;
  let scanned = 0;
  const old = async (path: string) => {
    try {
      const stat = await lstat(path);
      return stat.isFile() && now - stat.mtimeMs > graceMs;
    } catch {
      return false;
    }
  };
  const list = async (dir: string) => {
    try {
      return await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };
  for (const entry of await list(uploadDir)) {
    const dir = join(uploadDir, entry.name);
    if (entry.name === INCOMING_DIR && entry.isDirectory()) {
      for (const file of await list(dir)) {
        scanned += 1;
        if (await old(join(dir, file.name))) {
          await rm(join(dir, file.name), { force: true });
          partials += 1;
        }
      }
      continue;
    }
    if (!entry.isDirectory() || !OWNER.test(entry.name)) continue;
    const candidates: string[] = [];
    for (const file of await list(dir)) {
      scanned += 1;
      const path = join(dir, file.name);
      if (/\.tmp-[0-9a-f-]{36}$/u.test(file.name)) {
        if (await old(path)) {
          await rm(path, { force: true });
          partials += 1;
        }
      } else if (SHA256.test(file.name) && (await old(path))) {
        candidates.push(file.name);
      }
    }
    if (candidates.length === 0) continue;
    const live = await known(entry.name, candidates);
    for (const sha of candidates) {
      if (live.has(sha)) continue;
      // Re-checked against the clock: an upload of these bytes since the scan
      // renamed a fresh file onto this name, and its row may be one insert away.
      if (!(await old(join(dir, sha)))) continue;
      await rm(join(dir, sha), { force: true });
      orphans += 1;
    }
  }
  return { orphans, partials, scanned };
}

/** The bytes, or null when the file is not there. */
export async function readStoredFile(
  uploadDir: string,
  ownerId: string,
  sha256: string,
): Promise<Buffer | null> {
  try {
    return await readFile(storedFilePath(uploadDir, ownerId, sha256));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * The file as a stream with its size, or null when it is not there. Opened
 * before it is streamed, so a missing file is a 410 the caller can still
 * send, not a stream that errors after the headers went out; and the handle
 * keeps the bytes readable if the file is replaced or removed meanwhile.
 */
export async function openStoredFile(
  uploadDir: string,
  ownerId: string,
  sha256: string,
): Promise<{ stream: ReadStream; bytes: number } | null> {
  let handle;
  try {
    handle = await open(storedFilePath(uploadDir, ownerId, sha256), 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    return { stream: handle.createReadStream({ autoClose: true }), bytes: size };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Remove the file; a file already gone is not an error. */
export async function removeStoredFile(
  uploadDir: string,
  ownerId: string,
  sha256: string,
): Promise<void> {
  await rm(storedFilePath(uploadDir, ownerId, sha256), { force: true });
}

/**
 * Writes and removes a probe file: what `/health` on both services means by
 * "uploads ok". Readable is not enough; the API writes here, and a read-only
 * or unmounted volume must fail the check, not the first upload.
 */
export async function probeUploadDir(uploadDir: string): Promise<void> {
  if (!isAbsolute(uploadDir))
    throw new Error(`UPLOAD_DIR must be an absolute path, got ${uploadDir}`);
  await mkdir(uploadDir, { recursive: true });
  const probe = join(uploadDir, `.health-${randomUUID()}`);
  await writeFile(probe, '');
  await rm(probe, { force: true });
}
