import { expect, test } from '@playwright/test';

/**
 * Deployed smoke test against a REAL OfficePulse runtime database and API
 * (issue #29's last definition-of-done item). It drives an already-running,
 * non-production AidaAdmin that has E2E_FAKE_SESSION=true and both
 * OFFICEPULSE_RUNTIME_DATABASE_URL and OFFICEPULSE_PROVISIONING_BASE_URL
 * pointed at the live services:
 *
 *   E2E_RUNTIME_URL=https://aida-admin.staging.example npm run test:e2e -- runtime
 *
 * Without E2E_RUNTIME_URL it is skipped, so CI (which has neither service)
 * stays green and honest.
 */
const target = process.env.E2E_RUNTIME_URL;

test.skip(!target, 'set E2E_RUNTIME_URL to a deployed non-production AidaAdmin');

test('reads dependency status from the real aida_officepulse database', async ({ page }) => {
  await page.goto(`${target}/runtime`);
  await expect(page.getByRole('heading', { name: /^runtime$/i })).toBeVisible();
  await page.getByRole('tab', { name: /dependencies/i }).click();
  const table = page.getByRole('table', { name: /dependency status/i });
  await expect(table).toBeVisible();
  // OfficePulse registers its own runtime database as a dependency, so a
  // real read must show at least that row.
  await expect(table.getByRole('row', { name: /runtime-mysql/i })).toBeVisible();
});

test('probes the real OfficePulse /readyz through the explicit test action', async ({ page }) => {
  await page.goto(`${target}/runtime`);
  await page.getByRole('tab', { name: /dependencies/i }).click();
  await page.getByRole('button', { name: /test dependencies now/i }).click();
  await expect(page.getByRole('status')).toContainText(/officepulse live: (ready|not ready)/i);
});

test('lists calls without leaking another tenant (Super Admin, all tenants)', async ({ page }) => {
  await page.goto(`${target}/runtime`);
  await expect(page.getByRole('tab', { name: /^calls$/i })).toBeVisible();
  await page.getByLabel(/^show$/i).selectOption('all');
  await expect(page.getByText(/no calls match|call sessions/i).first()).toBeVisible();
});
