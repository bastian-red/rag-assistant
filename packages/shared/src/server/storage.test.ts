import { chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  probeUploadDir,
  readStoredFile,
  removeStoredFile,
  sha256Of,
  storedFilePath,
  writeStoredFile,
} from './storage';

const OWNER = 'cmvyipu990000jh1klg0198zp';
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rag-storage-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('stored files', () => {
  it('writes under <dir>/<owner>/<sha256> and reads the same bytes back', async () => {
    const bytes = new TextEncoder().encode('# Boiler\n');
    const { path, sha256 } = await writeStoredFile(dir, OWNER, bytes);
    expect(sha256).toBe(sha256Of(bytes));
    expect(path).toBe(join(dir, OWNER, sha256));
    expect(await readStoredFile(dir, OWNER, sha256)).toEqual(Buffer.from(bytes));
    // No temporary file left beside it.
    expect(await readdir(join(dir, OWNER))).toEqual([sha256]);
  });

  it('writing the same bytes twice keeps one file', async () => {
    const bytes = new TextEncoder().encode('same');
    await writeStoredFile(dir, OWNER, bytes);
    await writeStoredFile(dir, OWNER, bytes);
    expect(await readdir(join(dir, OWNER))).toHaveLength(1);
  });

  it('reads a missing file as null and removes one that is gone without error', async () => {
    const sha = 'a'.repeat(64);
    expect(await readStoredFile(dir, OWNER, sha)).toBeNull();
    await expect(removeStoredFile(dir, OWNER, sha)).resolves.toBeUndefined();
  });

  it('refuses a path that could leave the directory, and a relative directory', () => {
    expect(() => storedFilePath(dir, '../etc', 'a'.repeat(64))).toThrow(/owner/u);
    expect(() => storedFilePath(dir, OWNER, '../../passwd')).toThrow(/sha256/u);
    expect(() => storedFilePath('uploads', OWNER, 'a'.repeat(64))).toThrow(/absolute/u);
  });
});

describe('probeUploadDir', () => {
  it('passes on a writable folder and leaves nothing behind', async () => {
    await probeUploadDir(join(dir, 'fresh'));
    expect(await readdir(join(dir, 'fresh'))).toEqual([]);
  });

  it('fails on a folder it cannot write to', async () => {
    const locked = join(dir, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o500);
    try {
      // Root ignores permissions; the check is meaningful only as a user.
      if (process.getuid?.() !== 0) await expect(probeUploadDir(locked)).rejects.toThrow();
    } finally {
      await chmod(locked, 0o700);
    }
  });
});
