import { expect, formError, PEOPLE, signIn, signOut, signUp, test, type Person } from '../fixtures';

for (const who of Object.keys(PEOPLE) as Person[]) {
  test(`${who} lands in their own library, named as the API holds them`, async ({ page }) => {
    await signIn(page, who);
    await expect(page).toHaveURL(/\/$/u);
    await expect(page.getByTestId('who')).toContainText(PEOPLE[who].name);
    await expect(page.getByTestId('who')).toContainText(PEOPLE[who].email);
  });
}

test('each person sees their own collections, and none of the other person’s', async ({ page }) => {
  // The seed gives Alma "Home" (2 documents) and "Bike" (1), and Bruno "Lab"
  // (2), and stores their files where an upload's go. The ingest worker
  // e2e.sh started reads all five, so the counts end "ready to ask about":
  // seed -> stored file -> queue -> worker -> chunks -> API -> page.
  await signIn(page, 'alma');
  const shelves = page.getByTestId('collection');
  await expect(shelves.getByRole('heading')).toHaveText(['Bike', 'Home']);
  await expect(async () => {
    await page.reload();
    await expect(shelves.filter({ hasText: 'Home' })).toContainText(
      '2 documents: 2 ready to ask about',
      { timeout: 1_000 },
    );
  }).toPass({ timeout: 30_000 });
  await expect(page.getByTestId('collections')).not.toContainText('Lab');

  await signOut(page);
  await signIn(page, 'bruno');
  await expect(shelves.getByRole('heading')).toHaveText(['Lab']);
  await expect(shelves.filter({ hasText: 'Lab' })).toContainText('2 ready to ask about');
});

test('a wrong password is one answer, whatever was wrong', async ({ page }) => {
  for (const email of [PEOPLE.alma.email, 'nobody@rag.test']) {
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(formError(page)).toHaveText(/That email address and password do not match\./u);
  }
});

test('the library is private: signed out, it asks for a sign-in first', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in\?next=%2F$/u);
});

test('a signed-out deep link survives signing in, query and all', async ({ page }) => {
  // A page that does not exist yet is still private, and still comes back.
  await page.goto('/library?view=recent');
  await expect(page).toHaveURL(/\/sign-in\?next=%2Flibrary%3Fview%3Drecent/u);
  await page.getByLabel('Email').fill(PEOPLE.bruno.email);
  await page.getByLabel('Password').fill(PEOPLE.bruno.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/library\?view=recent$/u);
});

test('a crafted next cannot leave the site', async ({ page }) => {
  await signIn(page, 'alma', '//evil.example/steal');
  await expect(page).toHaveURL(/^http:\/\/[^/]+\/$/u);
});

test('sign out ends the session: the library asks again', async ({ page }) => {
  await signIn(page, 'alma');
  await signOut(page);
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in/u);
});

test('the status page needs no session', async ({ page }) => {
  await page.goto('/status');
  await expect(page).toHaveURL(/\/status$/u);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Status');
});

test('sign-up makes a private library and signs in; the same address twice is refused', async ({
  page,
}) => {
  await page.goto('/sign-in');
  await page.getByRole('link', { name: 'Create an account' }).click();
  await expect(page).toHaveURL(/\/sign-up$/u);
  const reader = await signUp(page, 'newcomer');
  await expect(page.getByTestId('who')).toContainText(reader.name);
  await expect(page.getByTestId('who')).toContainText(reader.email);
  await expect(page.getByTestId('collection')).toHaveCount(1);

  await signOut(page);
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('Someone else');
  await page.getByLabel('Email').fill(reader.email);
  await page.getByLabel('Password').fill('another-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(formError(page)).toHaveText(/An account with that email address already exists\./u);
});

test('a short password is refused before an account exists', async ({ page }) => {
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('Shorty');
  await page.getByLabel('Email').fill(`e2e-short-${String(Date.now())}@rag.test`);
  // Past the browser's own minlength check, to reach the server's rule.
  await page.getByLabel('Password').evaluate((input) => input.removeAttribute('minlength'));
  await page.getByLabel('Password').fill('elevenchars');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(formError(page)).toHaveText(/at least 12 characters/u);
});
