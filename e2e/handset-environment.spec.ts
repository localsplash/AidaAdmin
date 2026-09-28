import { expect, test } from '@playwright/test';

const origin = 'http://127.0.0.1:3102';
test('an admin sees the environment warning and can revoke an attached handset', async ({
  page,
  context,
}) => {
  await context.addCookies([{ name: 'aida.sid', value: 'tenant-admin', url: origin }]);
  const handset = {
    id: 'ed35265b-2199-46dd-9e46-99e3f9600111',
    pbxInstanceId: 'officepulse-staging',
    context: 'acme',
    endpointId: '411',
    extension: '411',
    label: 'Front Desk',
    deviceModel: 'GXV3450',
    mac: 'ec74d7c92718',
    localIp: '192.168.6.97',
    publicIp: '203.0.113.1',
    attachedAt: '2026-09-20T10:00:00Z',
    lastSeenAt: '2026-09-20T10:01:00Z',
    appVersion: '1',
    revokedAt: null,
  };
  let handsets = [handset];
  await page.route('**/api/environment', (route) =>
    route.fulfill({
      json: {
        environmentName: 'dev',
        officePulse: {
          reachable: true,
          environmentName: 'staging',
          pbxInstanceId: 'officepulse-staging',
        },
        mismatch: true,
      },
    }),
  );
  await page.route('**/admin/tenants/7/extensions', (route) =>
    route.fulfill({
      json: {
        source: 'asterisk',
        pbxInstanceId: 'officepulse-staging',
        context: 'acme',
        contexts: ['acme'],
        provisioningEnabled: true,
        extensions: [
          {
            id: '411',
            extension: '411',
            context: 'acme',
            callerId: 'Front Desk',
            managed: false,
            applyState: 'unknown',
          },
        ],
      },
    }),
  );
  await page.route('**/admin/tenants/7/handsets**', async (route) => {
    if (route.request().method() === 'DELETE') {
      expect(new URL(route.request().url()).searchParams.get('context')).toBe('acme');
      expect(route.request().headers()['x-csrf-token']).toBeTruthy();
      handsets = [];
      await route.fulfill({ status: 204 });
    } else await route.fulfill({ json: { handsets } });
  });
  await page.goto(`${origin}/tenants/7/extensions`);
  await expect(page.locator('.environment-label')).toContainText('Environment: dev');
  await expect(page.getByRole('alert')).toContainText(
    'OfficePulse is staging (PBX officepulse-staging)',
  );
  const row = page.getByRole('row', { name: /411 Front Desk/ });
  await expect(row).toContainText('GXV3450');
  await expect(row).toContainText('192.168.6.97');
  await expect(row).toContainText('203.0.113.1');
  await page.screenshot({ path: '/tmp/aidaadmin-handset-environment.png', fullPage: true });
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('not a lock');
    await dialog.accept();
  });
  await row.getByRole('button', { name: 'Revoke handset for extension 411' }).click();
  await expect(page.getByText('Handset revoked.', { exact: false })).toBeVisible();
  await expect(page.getByText('GXV3450')).toHaveCount(0);
  handsets = [{ ...handset, id: 'replacement-session' }];
  await page.getByRole('button', { name: 'Refresh inventory' }).click();
  await expect(page.getByText('GXV3450')).toBeVisible();
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('officepulse-staging');
});
