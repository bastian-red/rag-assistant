import { chmod, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  INCOMING_DIR,
  adoptIncomingFile,
  incomingFilePath,
  openStoredFile,
  probeUploadDir,
  readStoredFile,
  removeStoredFile,
  sha256Of,
  storedFilePath,
  sweepUploads,
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

describe('openStoredFile', () => {
  it('streams the stored bytes with their size, and is null for a missing file', async () => {
    const bytes = new TextEncoder().encode('# Streamed\n'.repeat(1_000));
    const { sha256 } = await writeStoredFile(dir, OWNER, bytes);
    const opened = await openStoredFile(dir, OWNER, sha256);
    expect(opened?.bytes).toBe(bytes.byteLength);
    const parts: Buffer[] = [];
    for await (const part of opened!.stream) parts.push(part as Buffer);
    expect(Buffer.concat(parts)).toEqual(Buffer.from(bytes));
    expect(await openStoredFile(dir, OWNER, sha256Of(new Uint8Array([1])))).toBeNull();
  });

  it('keeps serving what it opened when the file is removed mid-read', async () => {
    const bytes = new TextEncoder().encode('kept');
    const { sha256 } = await writeStoredFile(dir, OWNER, bytes);
    const opened = await openStoredFile(dir, OWNER, sha256);
    await removeStoredFile(dir, OWNER, sha256);
    const parts: Buffer[] = [];
    for await (const part of opened!.stream) parts.push(part as Buffer);
    expect(Buffer.concat(parts).toString()).toBe('kept');
  });
});

describe('incoming uploads', () => {
  it('stage inside UPLOAD_DIR and adopt to the stored name by rename', async () => {
    const incoming = await incomingFilePath(dir);
    expect(incoming.startsWith(join(dir, INCOMING_DIR) + '/')).toBe(true);
    const bytes = new TextEncoder().encode('# Staged\n');
    await writeFile(incoming, bytes);
    const path = await adoptIncomingFile(incoming, dir, OWNER, sha256Of(bytes));
    expect(path).toBe(storedFilePath(dir, OWNER, sha256Of(bytes)));
    expect(await readStoredFile(dir, OWNER, sha256Of(bytes))).toEqual(Buffer.from(bytes));
    expect(await readdir(join(dir, INCOMING_DIR))).toEqual([]);
  });
});

describe('sweepUploads', () => {
  const NOW = Date.parse('2026-11-06T12:00:00Z');
  const GRACE = 10 * 60_000;
  const OTHER = 'cmvyipu990000jh1klg0198zq';
  const age = async (path: string, ms: number) => {
    const t = new Date(NOW - ms);
    await utimes(path, t, t);
  };
  const put = async (owner: string, text: string, ms: number) => {
    const { path, sha256 } = await writeStoredFile(dir, owner, new TextEncoder().encode(text));
    await age(path, ms);
    return sha256;
  };

  it('removes old files with no row and old partials, and keeps everything else', async () => {
    const live = await put(OWNER, 'live', GRACE * 3);
    const orphan = await put(OWNER, 'orphan', GRACE * 3);
    const fresh = await put(OWNER, 'fresh orphan', GRACE / 2);
    const theirs = await put(OTHER, 'orphan', GRACE * 3); // same bytes, other owner, has a row
    const staged = await incomingFilePath(dir);
    await writeFile(staged, 'cut off');
    await age(staged, GRACE * 2);
    const stagedNow = await incomingFilePath(dir);
    await writeFile(stagedNow, 'still arriving');
    await age(stagedNow, 1_000);
    const tmp = join(dir, OWNER, `${live}.tmp-${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`);
    await writeFile(tmp, 'half');
    await age(tmp, GRACE * 2);
    await writeFile(join(dir, '.health-x'), '');

    const asked: [string, string[]][] = [];
    const rows: Record<string, string[]> = { [OWNER]: [live], [OTHER]: [theirs] };
    const result = await sweepUploads(
      dir,
      async (owner, shas) => {
        asked.push([owner, [...shas].sort()]);
        return new Set(shas.filter((s) => rows[owner]?.includes(s)));
      },
      { graceMs: GRACE, now: NOW },
    );

    expect(result).toEqual({ orphans: 1, partials: 2, scanned: 7 });
    expect((await readdir(join(dir, OWNER))).sort()).toEqual([fresh, live].sort());
    expect(await readdir(join(dir, OTHER))).toEqual([theirs]);
    expect(await readdir(join(dir, INCOMING_DIR))).toEqual([stagedNow.split('/').at(-1)]);
    // Only old, well-named files are asked about; a fresh one costs no query.
    expect(asked.sort()).toEqual(
      [
        [OTHER, [theirs]],
        [OWNER, [live, orphan].sort()],
      ].sort(),
    );
  });

  it('is a no-op on a directory that does not exist yet', async () => {
    const result = await sweepUploads(join(dir, 'none'), () => Promise.resolve(new Set()));
    expect(result).toEqual({ orphans: 0, partials: 0, scanned: 0 });
  });
});
