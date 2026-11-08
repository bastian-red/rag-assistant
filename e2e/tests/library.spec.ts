/**
 * The library (PRODUCT.md moment 1): drop a file and know when it is ready,
 * or why it failed. Each spec signs up its own reader, so its library holds
 * exactly what it uploads.
 */
import type { Page } from '@playwright/test';

import { expect, signUp, test } from '../fixtures';
import { boilerPdf, fakePdf } from '../pdf';

const fileInput = (page: Page) => page.getByLabel('Choose files, or drop them here');
const firstCollection = (page: Page) =>
  page.getByTestId('collection').getByRole('link', { name: 'My documents' });

test('a new account starts with one empty collection, and a file goes from upload to ready live', async ({
  page,
}) => {
  await signUp(page, 'library');
  await expect(page.getByTestId('collection')).toHaveCount(1);
  await expect(page.getByTestId('collection')).toContainText('No documents yet');

  await firstCollection(page).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('My documents');
  await expect(page.getByTestId('no-documents')).toBeVisible();

  await fileInput(page).setInputFiles({
    name: 'boiler.pdf',
    mimeType: 'application/pdf',
    buffer: boilerPdf(),
  });
  await expect(page.getByTestId('upload-results')).toContainText(
    'boiler.pdf: added, reading it now.',
  );
  const row = page.getByTestId('document');
  await expect(row).toHaveCount(1);
  // No reload: the ingest feed moves the row to READY while the page sits there.
  await expect(row.getByTestId('document-status')).toHaveText('✓ Ready to ask about', {
    timeout: 30_000,
  });
  await expect(row).toContainText('2 pages');
  // The settled document redraws the counts and offers to ask.
  await expect(page.getByRole('button', { name: 'Ask this collection' })).toBeVisible();
});

test('the same bytes twice are one document, and a fake PDF is refused with the reason', async ({
  page,
}) => {
  await signUp(page, 'dupes');
  await firstCollection(page).click();
  const upload = { name: 'boiler.pdf', mimeType: 'application/pdf', buffer: boilerPdf() };
  await fileInput(page).setInputFiles(upload);
  await expect(page.getByTestId('upload-results')).toContainText('added');
  await fileInput(page).setInputFiles({ ...upload, name: 'boiler-copy.pdf' });
  await expect(page.getByTestId('upload-results')).toContainText(
    'boiler-copy.pdf: already in your library as',
  );
  await expect(page.getByTestId('document')).toHaveCount(1);

  await fileInput(page).setInputFiles({
    name: 'not-really.pdf',
    mimeType: 'application/pdf',
    buffer: fakePdf(),
  });
  const refusal = page.getByTestId('upload-results').locator('[data-state="danger"]');
  await expect(refusal).toContainText('not-really.pdf:');
  await expect(page.getByTestId('document')).toHaveCount(1);
});

test('deleting asks in words first, and "Keep it" changes nothing', async ({ page }) => {
  await signUp(page, 'deleter');
  await firstCollection(page).click();
  await fileInput(page).setInputFiles({
    name: 'boiler.pdf',
    mimeType: 'application/pdf',
    buffer: boilerPdf(),
  });
  const row = page.getByTestId('document');
  await expect(row).toHaveCount(1);

  await row.getByRole('button', { name: /^Delete / }).click();
  await expect(row.getByRole('group')).toContainText('This cannot be undone.');
  // The safe answer has the focus, so a second Enter does nothing destructive.
  await expect(row.getByRole('button', { name: 'Keep it' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(row.getByRole('group')).toHaveCount(0);
  await expect(row).toHaveCount(1);

  await row.getByRole('button', { name: /^Delete / }).click();
  await row.getByRole('button', { name: 'Yes, delete it' }).click();
  await expect(page.getByTestId('no-documents')).toBeVisible();
});

test('a collection is created, opened, and deleted with its documents', async ({ page }) => {
  await signUp(page, 'shelves');
  await page.getByLabel('New collection').fill('Bike');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bike');

  await page.getByRole('button', { name: 'Delete collection' }).click();
  await expect(page.getByRole('group')).toContainText('Delete “Bike”? It holds no documents.');
  await page.getByRole('button', { name: 'Yes, delete the collection' }).click();
  await expect(page).toHaveURL(/\/$/u);
  await expect(page.getByTestId('collection')).toHaveCount(1);
  await expect(page.getByTestId('collections')).not.toContainText('Bike');
});

test('a taken collection name is refused in place', async ({ page }) => {
  await signUp(page, 'taken-name');
  await page.getByLabel('New collection').fill('My documents');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.form-error[role="alert"]')).toContainText(
    'You already have a collection called “My documents”.',
  );
});
