import { expect, test } from '@playwright/test';

test('renders the login-required state when unauthenticated', async ({ page }) => {
  await page.goto('http://localhost:3100/');
  await expect(page.getByRole('heading', { name: /sign in required/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /sign in/i })).toBeVisible();
});

test('renders the authenticated shell with tenant context banner', async ({ page }) => {
  await page.goto('http://localhost:3101/');
  await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible();
  await expect(page.getByRole('navigation', { name: /primary/i })).toBeVisible();
  await expect(page.getByText(/no tenant selected — acting as super admin/i)).toBeVisible();
});
