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
