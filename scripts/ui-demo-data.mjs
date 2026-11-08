#!/usr/bin/env node
/**
 * A conversation for the first seeded person, so every page of the app has
 * real content to show: one cited answer (the passage viewer is reached from
 * its chip) and one "Not found in your documents."
 *
 * Run by `./scripts/e2e.sh --serve`, against the fake model, so the answers
 * are the same on every run. Idempotent: a person who already has this
 * conversation is left alone. Everything goes through the API with a service
 * token, the way the web app talks to it; nothing is written to the database
 * directly.
 *
 * Run from packages/db so `@rag/db` and `@rag/shared/server` resolve.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(join(process.cwd(), 'package.json'));
const { createPrismaClient } = require('@rag/db');
const { mintServiceToken } = require('@rag/shared/server');

const QUESTIONS = ['When does the boiler warranty end?', 'Zebras quarterly velocity?'];
const COLLECTION = 'Home';
const api = process.env.API_BASE_URL ?? 'http://localhost:4600';
const secret = process.env.AUTH_SECRET;
if (!secret) throw new Error('ui-demo-data: AUTH_SECRET is not set.');

const seed = readFileSync(join(process.cwd(), 'prisma', 'seed.mts'), 'utf8');
const email = /^const FIRST_EMAIL = '([^']*)';/mu.exec(seed)?.[1];
if (email === undefined) throw new Error('ui-demo-data: FIRST_EMAIL not found in the seed.');

const prisma = createPrismaClient({ url: process.env.DATABASE_URL });
const user = await prisma.user.findUniqueOrThrow({
  where: { email },
  select: { id: true, email: true, name: true },
});
await prisma.$disconnect();

async function call(path, init = {}) {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${mintServiceToken(user, secret)}`,
      'x-forwarded-for': '10.250.0.1',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  });
  if (!response.ok) throw new Error(`ui-demo-data: ${path} answered ${String(response.status)}`);
  return response;
}

const { conversations } = await (await call('/conversations')).json();
if (conversations.some((c) => c.title === QUESTIONS[0])) {
  console.log(`ui-demo-data: ${email} already has the demo conversation.`);
  process.exit(0);
}

const { collections } = await (await call('/collections')).json();
const home = collections.find((c) => c.name === COLLECTION);
if (home === undefined) throw new Error(`ui-demo-data: ${email} has no "${COLLECTION}".`);

// The worker reads the seeded documents at start; ask once they are READY.
for (let i = 0; ; i += 1) {
  const { documents } = await (await call(`/documents?collectionId=${home.id}`)).json();
  if (documents.length > 0 && documents.every((d) => d.status === 'READY')) break;
  if (i === 60) throw new Error('ui-demo-data: the seeded documents never became READY.');
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

const conversation = await (
  await call('/conversations', { method: 'POST', body: JSON.stringify({ collectionId: home.id }) })
).json();
for (const content of QUESTIONS) {
  const response = await call(`/chat/${conversation.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
  const text = await response.text(); // the whole stream, to its end
  const ending = /event: (done|error)\n/u.exec(text)?.[1] ?? 'nothing';
  console.log(`ui-demo-data: "${content}" ended with ${ending}.`);
}
console.log(`ui-demo-data: ${email} has a conversation at /conversations/${conversation.id}.`);
