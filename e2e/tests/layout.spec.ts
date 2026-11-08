/**
 * A phone is a first-class width: no route scrolls sideways at 390 px.
 *
 * Measured as `scrollWidth > clientWidth` on the document, which is what a
 * reader feels as the page sliding under their thumb. Every later build step
 * adds its routes to the list in the same commit. The shell's own promises at
 * each width (the sidebar fold, a 24 px citation, no key hint on a touch
 * screen) are held here too.
 */
import type { Page } from '@playwright/test';

/** A new, empty conversation over Alma's whole library; `drop` deletes it again. */
async function openConversation(page: Page) {
  await page.getByRole('button', { name: 'Ask your whole library' }).click();
  await page.waitForURL(/\/conversations\//u);
  return async () => {
    await page.getByRole('button', { name: 'Delete conversation' }).click();
    await page.getByRole('button', { name: 'Yes, delete the conversation' }).click();
    await page.waitForURL((url) => url.pathname === '/');
  };
}

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
  // A citation is a 24 px target even set superscript (WCAG 2.5.8, UX-AUDIT #7).
  const box = await page.getByTestId('citation-chip').boundingBox();
  expect(box?.width, 'chip width').toBeGreaterThanOrEqual(24);
  expect(box?.height, 'chip height').toBeGreaterThanOrEqual(24);
  await page.getByTestId('citation-chip').click();
  await expect(page.getByTestId('quote')).toBeVisible();
  expect(await overflow(page), 'passage').toBeLessThanOrEqual(0);
  await page.goto(conversation);
  await page.getByRole('link', { name: 'Open the collection' }).click();
  await page.waitForLoadState('load');
  expect(await overflow(page), 'collection').toBeLessThanOrEqual(0);
});

test('the sidebar folds under the top bar at 390 px, opens on request, closes on arrival', async ({
  page,
}) => {
  await signIn(page, 'alma');
  const nav = page.getByRole('navigation', { name: 'Library and conversations' });
  const toggle = nav.getByRole('button', { name: 'Library and conversations' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(nav.getByRole('link', { name: 'Your library' })).toBeHidden();

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await nav.getByTestId('nav-collection').filter({ hasText: 'Home' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Home');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(await overflow(page), 'collection, sidebar used').toBeLessThanOrEqual(0);
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true, isMobile: true });
  // Firefox has no mobile emulation; the media query is the same engine-neutral CSS.
  test.skip(({ browserName }) => browserName === 'firefox', 'isMobile is Chromium-only');

  test('the composer does not name keys a phone does not have (UX-AUDIT #6)', async ({ page }) => {
    await signIn(page, 'alma');
    const drop = await openConversation(page);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await expect(page.getByText('Enter to ask, Shift+Enter for a new line.')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeVisible();
    await drop();
  });
});

test.describe('at desktop width', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the sidebar is simply there: no fold, no toggle', async ({ page }) => {
    await signIn(page, 'alma');
    const nav = page.getByRole('navigation', { name: 'Library and conversations' });
    await expect(nav.getByRole('button', { name: 'Library and conversations' })).toBeHidden();
    await expect(nav.getByRole('link', { name: 'Your library' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Your library' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // The keyboard hint is shown where there is a keyboard.
    const drop = await openConversation(page);
    await expect(page.getByText('Enter to ask, Shift+Enter for a new line.')).toBeVisible();
    await drop();
  });
});
