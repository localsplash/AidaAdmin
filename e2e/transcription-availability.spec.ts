import { expect, test } from '@playwright/test';

test('Live operations exposes transcription prerequisites without an active call', async ({
  page,
  context,
}) => {
  const origin = 'http://127.0.0.1:3102';
  await context.addCookies([{ name: 'aida.sid', value: 'tenant-admin', url: origin }]);
  await page.route('**/runtime/calls?*', (route) => route.fulfill({ json: { calls: [] } }));
  await page.route('**/runtime/issues?*', (route) =>
    route.fulfill({
      json: { windowHours: 24, failedCommands: [], events: [], dependenciesDown: [] },
    }),
  );
  await page.route('**/runtime/observation-status', (route) =>
    route.fulfill({
      json: { observerConfigured: false, admissionReady: false, livekitReady: false },
    }),
  );
  await page.goto(`${origin}/operations`);
  await expect(
    page.getByRole('heading', { name: 'Live transcription', exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/LiveKit observation has not been configured/)).toBeVisible();
  await expect(page.getByText(/Telephone-to-Aida routing is unavailable/)).toBeVisible();
  await expect(page.getByText('No active calls.')).toBeVisible();
  await expect(page.getByText(/Coming soon/)).toHaveCount(0);
  await page.screenshot({ path: 'test-results/transcription-availability.png', fullPage: true });
});
