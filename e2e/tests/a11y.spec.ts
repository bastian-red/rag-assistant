/**
 * axe over every route, in both colour schemes, zero violations.
 *
 * Every route: sign-in (with an error on screen), status, the library, and the
 * 404. Each build step adds its routes here in the same commit.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page, TestInfo } from '@playwright/test';

import { expect, signIn, test } from '../fixtures';

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

    test('the library and the 404, signed in', async ({ page }, testInfo) => {
      await signIn(page, 'alma');
      await scan(page, testInfo, '/', scheme);
      await page.goto('/no-such-page');
      await scan(page, testInfo, '/no-such-page', scheme);
    });
  });
}
