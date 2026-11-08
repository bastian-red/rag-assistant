/**
 * A phone is a first-class width: no route scrolls sideways at 390 px.
 *
 * Measured as `scrollWidth > clientWidth` on the document, which is what a
 * reader feels as the page sliding under their thumb. Every later build step
 * adds its routes to the list in the same commit.
 */
import type { Page } from '@playwright/test';

import { ask, expect, readerWithManual, scriptChat, signIn, test } from '../fixtures';
import { RADIATOR_SENTENCE } from '../pdf';

test.use({ viewport: { width: 390, height: 844 } });

async function overflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test('public routes do not scroll sideways at 390 px', async ({ page }) => {
  for (const path of ['/sign-in', '/sign-up', '/status']) {
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

test('a collection, a conversation and a passage do not scroll sideways at 390 px', async ({
  page,
}) => {
  await readerWithManual(page, 'narrow');
  const conversation = page.url();
  await scriptChat({ answer: `${RADIATOR_SENTENCE.slice(0, -1)} [S1].` });
  try {
    await ask(page, 'When should I bleed the radiators with the key?');
    await expect(page.getByTestId('turn').last()).toHaveAttribute('data-status', 'done');
  } finally {
    await scriptChat(null);
  }
  expect(await overflow(page), conversation).toBeLessThanOrEqual(0);
  await page.getByTestId('citation-chip').click();
  await expect(page.getByTestId('quote')).toBeVisible();
  expect(await overflow(page), 'passage').toBeLessThanOrEqual(0);
  await page.goto(conversation);
  await page.getByRole('link', { name: 'Open the collection' }).click();
  await page.waitForLoadState('load');
  expect(await overflow(page), 'collection').toBeLessThanOrEqual(0);
});
