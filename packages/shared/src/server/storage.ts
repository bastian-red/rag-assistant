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
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
