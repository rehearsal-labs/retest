// Playwright's starter test, from assets/example.spec.ts of create-playwright 1.17.139 (Apache-2.0, Copyright
// Microsoft Corporation), with the task app's address and texts in place of playwright.dev's. Its two tests, their
// calls, comments and matchers are the starter's own.
import { test, expect } from '@playwright/test';

test('has title', async ({ page }) => {
  await page.goto('/workflow/site');

  // Expect a title "to contain" a substring.
  await expect(page).toHaveTitle(/Home/);
});

test('get started link', async ({ page }) => {
  await page.goto('/workflow/site');

  // Click the get started link.
  await page.getByRole('link', { name: 'Projects' }).click();

  // Expects page to have a heading with the name of Installation.
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
});
