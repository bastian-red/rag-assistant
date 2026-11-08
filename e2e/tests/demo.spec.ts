/**
 * The README's demo, captured as frames by `scripts/demo-gif.sh` (DEMO=1 only;
 * playwright.config.ts ignores this file otherwise).
 *
 * The story, as Alma (the first seeded reader) asks her "Home" shelf:
 * the finished answer with its cited ticket (the cover), the library, the
 * collection with its documents ready, a second question with the returned
 * tickets already in and not one word of the answer yet, the same answer
 * done, the passage its citation opens, an honest "not found", and the
 * conversation on a phone by day and by night. 1280 x 800 each, so the GIF
 * does not jump.
 *
 * The fake model answers, so every frame is the same on every run; each
 * answer is a sentence of the seeded documents, cited by content (`[S:…]`,
 * resolved by the fake to whichever ticket holds those words), so what the
 * frames show is true of the documents. Alma is on the dev database: the
 * spec deletes the conversations it makes, and the empty or scripted ones
 * tooling left before it, and nothing else.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Locator, Page } from '@playwright/test';

import { ask, expect, scriptChat, signIn, test } from '../fixtures';

const SHOTS = join(__dirname, '..', 'demo-shots');

const WARRANTY = 'When does the boiler warranty end?';
const WARRANTY_ANSWER =
  'The warranty runs for seven years from the installation in March 2021, so it ends in March 2028 [S:seven years from the installation date]. ' +
  'It stays valid only if the boiler is serviced every twelve months by a registered engineer [S:serviced every twelve months].';
const RADIATORS = 'How do I bleed the radiators?';
const RADIATORS_ANSWER =
  'Bleed them at the start of each winter, upstairs first, with the heating off and cold [S:Bleed the radiators at the start].';
const NOTHING = 'Zebras quarterly velocity?';
/** Titles only tooling gives a conversation of Alma's: these may be deleted. */
const TOOLING = new Set(['New conversation', WARRANTY, RADIATORS, NOTHING]);

test.use({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });

async function frame(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== 'running'),
  );
  // A cover is judged by its text: no epoch milliseconds anywhere on screen.
  expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/\d{13}/u);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** Scroll so `element` sits just below the top of the window. */
async function top(element: Locator) {
  await element.evaluate((el) => {
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 16 });
  });
}

/** Delete Alma's conversations that tooling made, from her library page. */
async function tidy(page: Page) {
  await page.goto('/');
  for (;;) {
    const rows = page.getByTestId('conversation');
    const titles = await rows.locator('a').allInnerTexts();
    const index = titles.findIndex((t) => TOOLING.has(t.trim()));
    if (index === -1) return;
    const title = titles[index]!.trim();
    await page
      .getByRole('button', { name: `Delete the conversation “${title}”` })
      .first()
      .click();
    await page.getByRole('button', { name: 'Yes, delete the conversation' }).click();
    await expect(rows).toHaveCount(titles.length - 1);
  }
}

test.afterEach(async () => {
  await scriptChat(null);
});

test('demo', async ({ page, browser }) => {
  test.setTimeout(180_000);
  await signIn(page, 'alma');
  await tidy(page);

  try {
    // Ask "Home": the warranty, answered and cited.
    await page.getByRole('button', { name: 'Ask Home' }).click();
    await page.waitForURL(/\/conversations\//u);
    const conversation = page.url();
    await scriptChat({ answer: WARRANTY_ANSWER, tokenDelayMs: 0 });
    await ask(page, WARRANTY);
    const first = page.getByTestId('turn').last();
    await expect(first).toHaveAttribute('data-status', 'done');
    await expect(first.getByTestId('ticket-state').filter({ hasText: '✓ cited' })).toHaveCount(1);
    await page.reload();
    await expect(
      page.getByTestId('turn').last().getByTestId('citation-chip').first(),
    ).toBeVisible();
    await frame(page, '01-answer');

    await page.goto('/');
    await expect(page.getByTestId('collection').first()).toBeVisible();
    await frame(page, '02-library');

    await page.getByTestId('collection').getByRole('link', { name: 'Home' }).click();
    await expect(page.getByTestId('document-status').first()).toHaveText('✓ Ready to ask about');
    await frame(page, '03-collection');

    // The signature: the tickets are in, the answer is not yet.
    await page.goto(conversation);
    await scriptChat({ answer: RADIATORS_ANSWER, firstTokenDelayMs: 8_000, tokenDelayMs: 0 });
    await ask(page, RADIATORS);
    const second = page.getByTestId('turn').last();
    await expect(second.getByTestId('ticket').first()).toBeVisible();
    await expect(second).toHaveAttribute('data-status', 'answering');
    await top(second.locator('.slip'));
    await frame(page, '04-tickets-first');
    await expect(second).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
    await expect(second.getByTestId('ticket-state').filter({ hasText: '✓ cited' })).toHaveCount(1);
    // Slip at the top again: the tickets and, below them, the answer now in.
    await top(second.locator('.slip'));
    await expect(second.getByTestId('answer')).toBeInViewport();
    await frame(page, '05-answered');

    await second.getByTestId('citation-chip').first().click();
    await expect(page.getByTestId('quote')).toBeVisible();
    await frame(page, '06-passage');

    // Nothing in the shelf answers this: it says so, and asks no model.
    await page.goto(conversation);
    await ask(page, NOTHING);
    const third = page.getByTestId('turn').last();
    await expect(third.getByTestId('answer')).toContainText('Not found in your documents.');
    await third.scrollIntoViewIfNeeded();
    await frame(page, '07-not-found');

    // A phone by day and by night, joined side by side by demo-gif.sh.
    for (const [scheme, side] of [
      ['light', 'a'],
      ['dark', 'b'],
    ] as const) {
      const phone = await browser.newContext({
        viewport: { width: 390, height: 800 },
        colorScheme: scheme,
        deviceScaleFactor: 1,
      });
      const tab = await phone.newPage();
      await signIn(tab, 'alma');
      await tab.goto(conversation);
      const turn = tab.getByTestId('turn').first();
      await expect(turn.getByTestId('citation-chip').first()).toBeVisible();
      await turn.getByTestId('tickets').scrollIntoViewIfNeeded();
      await frame(tab, `08-phone.${side}`);
      await phone.close();
    }
  } finally {
    await tidy(page);
  }
});
