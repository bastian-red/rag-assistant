/**
 * The demo accounts: two people, each with a private library.
 *
 * Two, not one, on purpose: the isolation promise ("one user's documents are
 * invisible to every other user") needs a second library to be tested against.
 * Alma keeps home paperwork; Bruno keeps lab procedures, and one of his files
 * holds the CANARY phrase, which must never reach anything of Alma's: not her
 * retrieval candidates, prompt, answer or citations (docs/SPECS.md, outcome 3).
 *
 * The documents are the files under `prisma/corpus/`, recorded QUEUED with
 * the sha256 and size of the real bytes. The ingest worker (build step 5)
 * takes them from there to READY like any upload; the seed never writes
 * chunks or embeddings itself, so there is no second, seed-only path for
 * them to drift from.
 *
 * Properties (`scripts/seed-check.sh` proves them):
 *
 * 1. **Deterministic.** Ids are derived from stable keys, so two runs write
 *    identical rows (password hashes aside: scrypt salts them on purpose).
 * 2. **Idempotent, touching only its own rows.** People are upserted by email,
 *    collections by (owner, name), documents by (owner, sha256). A row created
 *    any other way is never touched, and a re-run never moves a document's
 *    status back (a READY document stays READY).
 * 3. **One canary, in Bruno's library only.**
 *
 * The client comes from this package's own source, not from `@rag/db`: a
 * package importing itself resolves to its `dist/`, which a clean checkout has
 * not built (turbo's `^build` covers dependencies, never the package itself).
 *
 * `scripts/dev-smoke.sh` and the E2E suite `sed` the `const NAME = '...'`
 * lines below. One line each, single quotes, no template literals. These are
 * local accounts for a local database, published on purpose so the README's
 * sign-in and `scripts/dev-smoke.sh` work on a fresh clone.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashPassword, writeStoredFile } from '@rag/shared/server';

import { createPrismaClient, type PrismaClient } from '../src/client.ts';

const FIRST_EMAIL = 'alma@rag.test';
const FIRST_PASSWORD = 'alma-password-2026';
const FIRST_NAME = 'Alma Rosales';
const SECOND_EMAIL = 'bruno@rag.test';
const SECOND_PASSWORD = 'bruno-password-2026';
const SECOND_NAME = 'Bruno Okafor';

/** A phrase that exists in exactly one seeded file, Bruno's. */
const CANARY = 'heliotrope-4417';

const PEOPLE = [
  { email: FIRST_EMAIL, password: FIRST_PASSWORD, name: FIRST_NAME },
  { email: SECOND_EMAIL, password: SECOND_PASSWORD, name: SECOND_NAME },
] as const;

const CORPUS = fileURLToPath(new URL('./corpus/', import.meta.url));

/** Who owns which collection, and the corpus files in it. */
const LIBRARY = [
  {
    owner: FIRST_EMAIL,
    collection: 'Home',
    files: ['alma/home/boiler-service-record.md', 'alma/home/lease-summary.md'],
  },
  { owner: FIRST_EMAIL, collection: 'Bike', files: ['alma/bike/commuter-bike-maintenance.txt'] },
  {
    owner: SECOND_EMAIL,
    collection: 'Lab',
    files: ['bruno/lab/cold-room-and-freezers.md', 'bruno/lab/safety-induction.md'],
  },
] as const;

const MIME: Record<string, string> = { '.md': 'text/markdown', '.txt': 'text/plain' };

/** A cuid-shaped id (lowercase, 25 characters) derived from a stable key. */
function seedId(kind: string, key: string): string {
  return `c${createHash('sha256').update(`${kind}:${key}`).digest('hex').slice(0, 24)}`;
}

async function seedPeople(prisma: PrismaClient): Promise<number> {
  for (const person of PEOPLE) {
    const data = { name: person.name, passwordHash: hashPassword(person.password) };
    await prisma.user.upsert({
      where: { email: person.email },
      create: { id: seedId('user', person.email), email: person.email, ...data },
      update: data,
    });
  }
  return PEOPLE.length;
}

/** The file's first line, without a markdown heading's `#`. */
function titleOf(text: string): string {
  return (text.split('\n', 1)[0] ?? '').replace(/^#+\s*/u, '').trim();
}

interface CorpusFile {
  owner: string;
  collection: string;
  file: string;
  bytes: Buffer;
  text: string;
  sha256: string;
  mime: string;
}

/**
 * Read and check the whole corpus BEFORE any write: a corpus that breaks the
 * canary rule (absent, duplicated, or in Alma's library) must leave the
 * database untouched, not half-seeded with the row that broke it.
 */
function readCorpus(): CorpusFile[] {
  const files = LIBRARY.flatMap((shelf) =>
    shelf.files.map((file) => {
      const bytes = readFileSync(join(CORPUS, file));
      const mime = MIME[extname(file)];
      if (mime === undefined) throw new Error(`seed: no MIME type for ${file}`);
      return {
        owner: shelf.owner,
        collection: shelf.collection,
        file,
        bytes,
        text: bytes.toString('utf8'),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        mime,
      };
    }),
  );
  const canary = files.filter((f) => f.text.includes(CANARY));
  if (canary.length !== 1 || canary[0]!.owner !== SECOND_EMAIL) {
    throw new Error(
      `seed: the canary must be in exactly one of Bruno's files, found in [${canary
        .map((f) => `${f.owner}:${f.file}`)
        .join(', ')}]. Nothing was written.`,
    );
  }
  return files;
}

async function seedLibraries(
  prisma: PrismaClient,
  files: CorpusFile[],
): Promise<{ collections: number; documents: number }> {
  for (const shelf of LIBRARY) {
    const ownerId = seedId('user', shelf.owner);
    const collection = await prisma.collection.upsert({
      where: { ownerId_name: { ownerId, name: shelf.collection } },
      create: {
        id: seedId('collection', `${shelf.owner}/${shelf.collection}`),
        ownerId,
        name: shelf.collection,
      },
      update: {},
    });
    for (const f of files.filter(
      (x) => x.owner === shelf.owner && x.collection === shelf.collection,
    )) {
      const filename = f.file.slice(f.file.lastIndexOf('/') + 1);
      // The bytes go where an upload's would, so the ingest worker reads a
      // seeded document exactly as it reads an uploaded one.
      if (uploadDir !== null) await writeStoredFile(uploadDir, ownerId, f.bytes);
      await prisma.document.upsert({
        where: { ownerId_sha256: { ownerId, sha256: f.sha256 } },
        create: {
          id: seedId('document', `${shelf.owner}/${f.sha256}`),
          ownerId,
          collectionId: collection.id,
          title: titleOf(f.text),
          filename,
          mime: f.mime,
          bytes: f.bytes.length,
          sha256: f.sha256,
        },
        // Status, error and pages belong to the ingest worker from here on.
        update: { collectionId: collection.id, title: titleOf(f.text), filename },
      });
    }
  }
  return { collections: LIBRARY.length, documents: files.length };
}

/**
 * Where the corpus bytes are stored for the worker. Unset means rows only
 * (the database suite needs no files); set, it must be absolute, the same
 * rule the API and the worker hold (scripts/load-env.sh resolves `.data/uploads`).
 */
const uploadDir =
  process.env.UPLOAD_DIR === undefined || process.env.UPLOAD_DIR === ''
    ? null
    : process.env.UPLOAD_DIR;

const corpus = readCorpus();
const prisma = createPrismaClient();
try {
  const people = await seedPeople(prisma);
  const { collections, documents } = await seedLibraries(prisma, corpus);
  console.info(
    `seed: ${String(people)} people, ${String(collections)} collections, ${String(documents)} documents queued${uploadDir === null ? ' (no UPLOAD_DIR: files not stored)' : ''}`,
  );
} finally {
  await prisma.$disconnect();
}
