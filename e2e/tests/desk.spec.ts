/**
 * The reference desk (docs/DESIGN.md): the design's own promises, each one a
 * check that fails if the design stops keeping it.
 *
 * - the returned tickets arrive before the first word of the answer;
 * - a ticket's number is the number the answer cites it by, and both open
 *   the same quote;
 * - once the answer is done every ticket says, in a word, whether it was
 *   cited; a reopened answer keeps its cited tickets (UX-AUDIT #3);
 * - the tickets drop in only when motion is welcome;
 * - a markdown passage reads as a document, not as its source (UX-AUDIT #1),
 *   and says the section the quote is in (UX-AUDIT #2).
 */
import { ask, expect, readerWithManual, scriptChat, signUp, test } from '../fixtures';
import { RADIATOR_SENTENCE } from '../pdf';

test.afterEach(async () => {
  await scriptChat(null);
});

test('the tickets come back before the words, numbered as the answer cites them', async ({
  page,
}) => {
  await readerWithManual(page, 'desk');
  // A long pause before the first word: the window in which only the tickets exist.
  await scriptChat({
    answer: `${RADIATOR_SENTENCE.slice(0, -1)} [S1].`,
    firstTokenDelayMs: 2500,
    tokenDelayMs: 10,
  });
  await ask(page, 'When should I bleed the radiators with the key?');
  const turn = page.getByTestId('turn').last();

  // The question is filed as a slip, stamped with the shelf it was asked of.
  await expect(turn.locator('.slip .question')).toHaveText(
    'You asked: When should I bleed the radiators with the key?',
  );
  await expect(turn.locator('.slip .stamp')).toContainText('My documents');

  const tickets = turn.getByTestId('ticket');
  await expect(tickets.first()).toBeVisible();
  await expect(turn.getByTestId('tickets')).toHaveAttribute(
    'aria-label',
    /^Returned: \d+ passage/u,
  );
  // Tickets, and not one word of the answer yet.
  expect(await turn.getByTestId('answer').innerText()).toBe('');
  await expect(turn).toHaveAttribute('data-status', 'answering');

  await expect(turn).toHaveAttribute('data-status', 'done');
  const chip = turn.getByTestId('citation-chip');
  await expect(chip).toHaveText('1');
  const first = tickets.filter({ has: page.locator('.ticket-no', { hasText: /^Source 1: $/u }) });
  await expect(first).toHaveCount(1);
  await expect(first.getByTestId('ticket-state')).toHaveText('✓ cited');
  // One object: the chip and its ticket open the same quote.
  const ticketHref = await first.getByRole('link').getAttribute('href');
  expect(ticketHref).toMatch(/\?from=\d+&to=\d+$/u);
  expect(await chip.getAttribute('href')).toBe(ticketHref);
  await expect(turn.getByTestId('tickets')).toHaveAttribute(
    'aria-label',
    /^Returned: cited 1 of \d+$/u,
  );
  // Every other ticket says it was not cited: a word, not a fainter colour.
  const others = await tickets.count();
  if (others > 1) {
    await expect(tickets.getByTestId('ticket-state').filter({ hasText: 'not cited' })).toHaveCount(
      others - 1,
    );
  }

  await first.getByRole('link').click();
  await expect(page.getByTestId('quote')).toHaveText(RADIATOR_SENTENCE);

  // Reopened: the evidence is still there, as the cited passages.
  await page.goBack();
  await page.reload();
  const stored = page.getByTestId('turn').last();
  await expect(stored.getByTestId('tickets')).toHaveAttribute('aria-label', 'Cited: 1 passage');
  await expect(stored.getByTestId('ticket')).toHaveCount(1);
  await expect(stored.getByTestId('ticket').getByRole('link')).toHaveAttribute('href', ticketHref!);
  await expect(stored.getByTestId('ticket-state')).toHaveText('✓ cited');
});

test('the tickets drop in only when motion is welcome', async ({ page }) => {
  await readerWithManual(page, 'motion');
  await scriptChat({ answer: `${RADIATOR_SENTENCE.slice(0, -1)} [S1].` });
  await ask(page, 'When should I bleed the radiators with the key?');
  const ticket = page.getByTestId('turn').last().getByTestId('ticket').first();
  await expect(page.getByTestId('turn').last()).toHaveAttribute('data-status', 'done');

  const animation = () => ticket.evaluate((el) => getComputedStyle(el).animationName);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(await animation()).toBe('ticket-in');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await animation()).toBe('none');
});

test('a markdown passage reads as a document and names the section of the quote', async ({
  page,
}) => {
  await signUp(page, 'markdown');
  await page.getByTestId('collection').getByRole('link', { name: 'My documents' }).click();
  const note = [
    '# Bike notes',
    '',
    '## Chain',
    '',
    'Clean the chain every two weeks with a dry rag,',
    'then oil each link once and wipe off the excess.',
    '',
    '## Tyres',
    '',
    'Pump the tyres to 5 bar before a long ride.',
  ].join('\n');
  await page
    .getByLabel('Choose files, or drop them here')
    .setInputFiles({ name: 'bike.md', mimeType: 'text/markdown', buffer: Buffer.from(note) });
  await expect(page.getByTestId('document-status')).toHaveText('✓ Ready to ask about', {
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Ask this collection' }).click();
  await page.waitForURL(/\/conversations\//u);

  await scriptChat({ answer: 'Pump the tyres to 5 bar before a long ride [S1].' });
  await ask(page, 'How hard should I pump the tyres before a long ride?');
  const turn = page.getByTestId('turn').last();
  await expect(turn).toHaveAttribute('data-status', 'done');
  await turn.getByTestId('citation-chip').click();

  const passage = page.getByTestId('passage');
  // Headings are headings, and no markup is shown.
  await expect(passage.getByRole('heading', { name: 'Tyres' })).toBeVisible();
  await expect(passage).not.toContainText('##');
  // One paragraph of prose (the reflow itself is held in passage-blocks.test.ts:
  // toHaveText collapses whitespace, so it cannot see a newline here).
  await expect(passage.locator('p', { hasText: 'Clean the chain' })).toHaveText(
    'Clean the chain every two weeks with a dry rag, then oil each link once and wipe off the excess.',
  );
  await expect(page.getByTestId('quote')).toHaveText('Pump the tyres to 5 bar before a long ride.');
  // Where the quote is: its section, not the title again.
  await expect(page.getByTestId('passage-where')).toHaveText('Tyres');
});
