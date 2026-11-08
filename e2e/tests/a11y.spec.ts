/**
 * axe over every route, in both colour schemes, zero violations.
 *
 * Every route: sign-in and sign-up (each with an error on screen), status,
 * the library, a collection (with a delete question open), a conversation
 * with a cited answer, the passage viewer, and the 404. Each build step adds
 * its routes here in the same commit.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page, TestInfo } from '@playwright/test';

import { ask, expect, readerWithManual, scriptChat, signIn, test } from '../fixtures';
import { RADIATOR_SENTENCE } from '../pdf';

const SCHEMES = ['light', 'dark'] as const;
const RECORDING = process.env.BASELINE === '1';

async function scan(page: Page, testInfo: TestInfo, route: string, scheme: string) {
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== 'running'),
  );
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  if (RECORDING) {
    await testInfo.attach('a11y', {
      contentType: 'application/json',
      body: JSON.stringify({ route, scheme, violations: results.violations }),
    });
    return;
  }
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target.join(' ')),
    })),
  ).toEqual([]);
}

for (const scheme of SCHEMES) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test('status', async ({ page }, testInfo) => {
      await page.goto('/status');
      await scan(page, testInfo, '/status', scheme);
    });

    test('sign in, with an error on screen', async ({ page }, testInfo) => {
      await page.goto('/sign-in');
      await scan(page, testInfo, '/sign-in', scheme);
      await page.getByLabel('Email').fill('nobody@rag.test');
      await page.getByLabel('Password').fill('wrong-password');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.locator('.form-error[role="alert"]')).toBeVisible();
      await scan(page, testInfo, '/sign-in (error)', scheme);
    });

    test('sign up, with an error on screen', async ({ page }, testInfo) => {
      await page.goto('/sign-up');
      await scan(page, testInfo, '/sign-up', scheme);
      await page.getByLabel('Name').fill('Taken');
      await page.getByLabel('Email').fill('alma@rag.test');
      await page.getByLabel('Password').fill('a-long-enough-password');
      await page.getByRole('button', { name: 'Create account' }).click();
      await expect(page.locator('.form-error[role="alert"]')).toBeVisible();
      await scan(page, testInfo, '/sign-up (error)', scheme);
    });

    test('a collection, a cited answer and its passage', async ({ page }, testInfo) => {
      await readerWithManual(page, `a11y-${scheme}`);
      const conversation = page.url();
      await page.getByRole('link', { name: 'Open the collection' }).click();
      await scan(page, testInfo, '/collections/[id]', scheme);
      await page
        .getByTestId('document')
        .getByRole('button', { name: /^Delete / })
        .click();
      await scan(page, testInfo, '/collections/[id] (confirm)', scheme);

      await page.goto(conversation);
      await scriptChat({ answer: `${RADIATOR_SENTENCE.slice(0, -1)} [S1].` });
      try {
        await ask(page, 'When should I bleed the radiators with the key?');
        await expect(page.getByTestId('turn').last()).toHaveAttribute('data-status', 'done');
      } finally {
        await scriptChat(null);
      }
      await scan(page, testInfo, '/conversations/[id]', scheme);
      await page.getByTestId('citation-chip').click();
      await expect(page.getByTestId('quote')).toBeVisible();
      await scan(page, testInfo, '/documents/[id]/passages/[chunkId]', scheme);
    });

    test('the library and the 404, signed in', async ({ page }, testInfo) => {
      await signIn(page, 'alma');
      await scan(page, testInfo, '/', scheme);
      await page.goto('/no-such-page');
      await scan(page, testInfo, '/no-such-page', scheme);
    });
  });
}
