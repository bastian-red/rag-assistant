/**
 * A phone is a first-class width: no route scrolls sideways at 390 px.
 *
 * Measured as `scrollWidth > clientWidth` on the document, which is what a
 * reader feels as the page sliding under their thumb. Every later build step
 * adds its routes to the list in the same commit.
 */
import type { Page } from '@playwright/test';

import { expect, signIn, test } from '../fixtures';

test.use({ viewport: { width: 390, height: 844 } });

async function overflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test('public routes do not scroll sideways at 390 px', async ({ page }) => {
  for (const path of ['/sign-in', '/status']) {
    await page.goto(path);
    expect(await overflow(page), path).toBeLessThanOrEqual(0);
  }
});

test('private routes do not scroll sideways at 390 px', async ({ page }) => {
  await signIn(page, 'alma');
  for (const path of ['/', '/no-such-page']) {
    await page.goto(path);
    await page.waitForLoadState('load');
    expect(await overflow(page), path).toBeLessThanOrEqual(0);
  }
});
