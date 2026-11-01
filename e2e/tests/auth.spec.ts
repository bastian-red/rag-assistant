import { expect, formError, PEOPLE, signIn, signOut, test, type Person } from '../fixtures';

for (const who of Object.keys(PEOPLE) as Person[]) {
  test(`${who} lands in their own library, named as the API holds them`, async ({ page }) => {
    await signIn(page, who);
    await expect(page).toHaveURL(/\/$/u);
    await expect(page.getByTestId('who')).toContainText(PEOPLE[who].name);
    await expect(page.getByTestId('who')).toContainText(PEOPLE[who].email);
  });
}

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
