/**
 * Asking (PRODUCT.md moments 2-5), against the fake model so every answer is
 * known in advance. Each spec signs up its own reader with one document, so
 * `[S1]` can only be that document.
 *
 * SPECS #10: upload, wait for READY, ask, receive a streamed answer, click a
 * citation, land on the right page with the passage highlighted.
 */
import { ask, expect, fakeChats, readerWithManual, scriptChat, test } from '../fixtures';
import { RADIATOR_SENTENCE } from '../pdf';

test.afterEach(async () => {
  await scriptChat(null);
});

test('SPECS #10: a streamed answer whose citation lands on page 2, the quote marked', async ({
  page,
}) => {
  await readerWithManual(page, 'asker');
  // The fake answers the sentence that is only on page 2, citing the one source.
  await scriptChat({ answer: `${RADIATOR_SENTENCE.slice(0, -1)} [S1].`, tokenDelayMs: 20 });
  await ask(page, 'When should I bleed the radiators with the key?');

  const turn = page.getByTestId('turn').last();
  // The returned tickets arrive before the words (moment 2; desk.spec.ts holds the order).
  await expect(turn.getByTestId('tickets')).toContainText('boiler');
  await expect(turn).toHaveAttribute('data-status', 'done');
  await expect(turn.getByTestId('answer')).toContainText('Bleed the radiators every autumn');
  // Announced once, on completion, without the marker.
  await expect(page.getByTestId('announcer')).toHaveText(`Answer: ${RADIATOR_SENTENCE}`);

  const chip = turn.getByTestId('citation-chip');
  await expect(chip).toHaveText('1');
  await expect(chip).toHaveAttribute('aria-label', /^Source 1: boiler.*, page 2$/u);
  await chip.click();

  await expect(page).toHaveURL(/\/documents\/[a-z0-9]+\/passages\/[a-z0-9]+\?from=\d+&to=\d+$/u);
  await expect(page.getByTestId('passage-where')).toHaveText(/^Page 2/u);
  await expect(page.getByTestId('quote')).toHaveText(RADIATOR_SENTENCE);
  const original = page.getByTestId('original');
  await expect(original).toHaveText('Open the original at page 2');
  await expect(original).toHaveAttribute('href', /\/api\/documents\/[a-z0-9]+\/file#page=2$/u);

  // The original is the uploaded PDF, served through this app with its safety headers.
  const href = await original.getAttribute('href');
  const response = await page.request.get(href!.replace(/#.*$/u, ''));
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('application/pdf');
  expect(response.headers()['x-content-type-options']).toBe('nosniff');
  expect((await response.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
});

test('Stop keeps the words written so far, the API stores them, and the model call is aborted', async ({
  page,
}) => {
  await readerWithManual(page, 'stopper');
  await scriptChat({
    answer: `${'The pressure gauge should read between one and one and a half bar. '.repeat(20)}[S1].`,
    tokenDelayMs: 150,
  });
  await ask(page, 'What should the boiler pressure gauge read?');
  const turn = page.getByTestId('turn').last();
  await expect(turn.getByTestId('answer')).toContainText('pressure gauge');
  await page.getByTestId('stop').click();

  await expect(turn).toHaveAttribute('data-status', 'stopped');
  await expect(turn.getByTestId('stopped')).toBeVisible();
  const shown = (await turn.getByTestId('answer').innerText()).trim();
  expect(shown.length).toBeGreaterThan(0);

  // The fake model saw the request go away before its last piece.
  await expect(async () => {
    const last = (await fakeChats()).at(-1)!;
    expect(last).toMatchObject({ aborted: true, completed: false });
  }).toPass({ timeout: 10_000 });

  // Stored as STOPPED with at least what the reader saw.
  await page.reload();
  const stored = page.getByTestId('turn').last();
  await expect(stored).toHaveAttribute('data-status', 'stopped');
  const kept = (await stored.getByTestId('answer').innerText()).trim();
  expect(kept.startsWith(shown.slice(0, 20))).toBe(true);
  expect(kept.length).toBeGreaterThanOrEqual(shown.length);
});

test('a question nothing answers gets a plain "Not found", and no model call', async ({ page }) => {
  await readerWithManual(page, 'abstainer');
  const before = (await fakeChats()).length;
  await ask(page, 'Zebras quarterly velocity?');
  const turn = page.getByTestId('turn').last();
  await expect(turn).toHaveAttribute('data-status', 'done');
  await expect(turn.getByTestId('answer')).toContainText('Not found in your documents.');
  await expect(page.getByTestId('announcer')).toHaveText('Not found in your documents.');
  expect((await fakeChats()).length).toBe(before);
});

test('a conversation is kept: titled by its question, reopened with its citations, deleted on request', async ({
  page,
}) => {
  await readerWithManual(page, 'historian');
  await scriptChat({ answer: `${RADIATOR_SENTENCE.slice(0, -1)} [S1].` });
  await ask(page, 'When should I bleed the radiators with the key?');
  await expect(page.getByTestId('turn').last()).toHaveAttribute('data-status', 'done');
  await expect(page.getByTestId('conversation-title')).toHaveText(
    'When should I bleed the radiators with the key?',
  );

  await page
    .getByRole('navigation', { name: 'Library and conversations' })
    .getByRole('link', { name: 'Your library' })
    .click();
  const conversation = page.getByTestId('conversation');
  await expect(conversation).toHaveCount(1);
  await conversation.getByRole('link').click();
  // Rendered from storage: the chip now carries the stored quote span.
  const chip = page.getByTestId('citation-chip');
  await expect(chip).toHaveAttribute('href', /\?from=\d+&to=\d+$/u);

  await page.getByRole('button', { name: 'Delete conversation' }).click();
  await page.getByRole('button', { name: 'Yes, delete the conversation' }).click();
  await expect(page).toHaveURL(/\/$/u);
  await expect(page.getByTestId('no-conversations')).toBeVisible();
});
