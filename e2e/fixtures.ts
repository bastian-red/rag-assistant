/**
 * Shared E2E helpers.
 *
 * The seeded facts are read out of `packages/db/prisma/seed.mts` rather than
 * retyped, so a renamed seed account fails here with a sentence instead of
 * every spec failing with "element not found".
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test as base, type Page } from '@playwright/test';

import { boilerPdf } from './pdf';

const SEED = readFileSync(join(__dirname, '..', 'packages', 'db', 'prisma', 'seed.mts'), 'utf8');

function seedConst(name: string): string {
  const match = new RegExp(`^const ${name} = '([^']*)';`, 'm').exec(SEED);
  if (!match) throw new Error(`Could not read ${name} out of packages/db/prisma/seed.mts.`);
  return match[1]!;
}

/** The two seeded people, each with a private library. */
export const PEOPLE = {
  alma: {
    email: seedConst('FIRST_EMAIL'),
    password: seedConst('FIRST_PASSWORD'),
    name: seedConst('FIRST_NAME'),
  },
  bruno: {
    email: seedConst('SECOND_EMAIL'),
    password: seedConst('SECOND_PASSWORD'),
    name: seedConst('SECOND_NAME'),
  },
} as const;
export type Person = keyof typeof PEOPLE;

export const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:4600';

/** The fake model server e2e.sh starts (its control route lets a spec remove a model). */
/** The worker's health server, which e2e.sh starts on INGEST_PORT. */
export const INGEST_HEALTH_URL = `http://127.0.0.1:${process.env.INGEST_PORT ?? '4500'}/health`;
export const FAKE_OLLAMA_URL = `http://127.0.0.1:${process.env.E2E_FAKE_OLLAMA_PORT ?? '11536'}`;
export const MODELS = {
  chat: process.env.CHAT_MODEL ?? 'qwen3:4b-instruct',
  embed: process.env.EMBED_MODEL ?? 'qwen3-embedding:0.6b',
};

export function randomAddress(): string {
  const octet = () => String(1 + Math.floor(Math.random() * 254));
  return `10.${octet()}.${octet()}.${octet()}`;
}

/** Sign in through the form, as a person would, and wait for the redirect chain to finish. */
export async function signIn(page: Page, who: Person = 'alma', next?: string) {
  const person = PEOPLE[who];
  await page.goto(next === undefined ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Email').fill(person.email);
  await page.getByLabel('Password').fill(person.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Wait for the END of the redirect chain, not its first hop: navigating
  // mid-chain aborts it (Firefox: NS_BINDING_ABORTED).
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'));
  await page.waitForLoadState('load');
}

/** Sign out and wait until the sign-in page has finished loading. */
export async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/sign-in/u);
  await page.waitForLoadState('load');
}

/**
 * A fresh account through the sign-up form, signed in on its new (empty)
 * library. Specs that upload or ask use one each, so no spec's documents can
 * change another's answers. `scripts/e2e.sh` removes these accounts before
 * the next run (their emails start `e2e-`).
 */
export async function signUp(page: Page, label = 'reader') {
  const email = `e2e-${label}-${String(Date.now())}-${String(Math.floor(Math.random() * 1e6))}@rag.test`;
  const password = 'e2e-password-long-enough';
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill(`E2E ${label}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL((url) => url.pathname === '/');
  await page.waitForLoadState('load');
  return { email, password, name: `E2E ${label}` };
}

/** A reader with the boiler PDF READY, on a new conversation over its collection. */
export async function readerWithManual(page: Page, label: string) {
  await signUp(page, label);
  await page.getByTestId('collection').getByRole('link', { name: 'My documents' }).click();
  await page
    .getByLabel('Choose files, or drop them here')
    .setInputFiles({ name: 'boiler.pdf', mimeType: 'application/pdf', buffer: boilerPdf() });
  await expect(page.getByTestId('document-status')).toHaveText('✓ Ready to ask about', {
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Ask this collection' }).click();
  await page.waitForURL(/\/conversations\//u);
  await expect(page.getByTestId('no-turns')).toBeVisible();
}

/** Ask in the open conversation. */
export async function ask(page: Page, question: string) {
  await page.getByLabel('Your question').fill(question);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
}

/** How the fake model answers the next questions (`PUT /__fake/chat`); `null` resets it. */
export async function scriptChat(script: Record<string, unknown> | null) {
  const response = await fetch(`${FAKE_OLLAMA_URL}/__fake/chat`, {
    method: script === null ? 'DELETE' : 'PUT',
    ...(script === null
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(script) }),
  });
  if (!response.ok)
    throw new Error(`the fake model refused the script: ${String(response.status)}`);
}

/** The fake model's record of every chat, newest last. */
export async function fakeChats(): Promise<
  { aborted: boolean; completed: boolean; piecesSent: number }[]
> {
  const response = await fetch(`${FAKE_OLLAMA_URL}/__fake/log`);
  return (
    (await response.json()) as {
      chats: { aborted: boolean; completed: boolean; piecesSent: number }[];
    }
  ).chats;
}

/**
 * A form's own error. Not getByRole('alert'): Next's route announcer is an
 * alert too, so that query matches two elements on every page.
 */
export const formError = (page: Page) => page.locator('.form-error[role="alert"]');

/**
 * Every spec fails on an uncaught error in the page, and every spec's browser
 * comes from its own address.
 *
 * The address: the web server forwards the browser's X-Forwarded-For to the
 * API, which keys its sign-in budget (5 a minute, the documented value) on it.
 * One shared address would make the sixth sign-in of the run a 429; a lifted
 * budget would hide real limiter bugs. A fresh address per test is how many
 * real people look.
 */
export const test = base.extend<{ failOnPageError: void }>({
  // Playwright reads a fixture's dependencies from the first parameter's
  // destructuring pattern, so an empty one is its documented form.
  // eslint-disable-next-line no-empty-pattern
  extraHTTPHeaders: async ({}, use) => {
    await use({ 'x-forwarded-for': randomAddress() });
  },
  failOnPageError: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await use();
      expect(errors, 'uncaught errors in the page').toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };
