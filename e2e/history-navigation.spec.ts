import { expect, test } from '@playwright/test';

const origin = 'http://127.0.0.1:3102';
test('history and call details support direct navigation and reload without live controls', async ({
  page,
  context,
}) => {
  await context.addCookies([{ name: 'aida.sid', value: 'tenant-admin', url: origin }]);
  await page.route('**/runtime/calls?*', (route) => route.fulfill({ json: { calls: [] } }));
  await page.route('**/runtime/calls/ended-call?*', (route) =>
    route.fulfill({
      json: {
        call: {
          id: 'ended-call',
          tenantId: '7',
          callerNumber: '+15555550101',
          didE164: '+15555550100',
          config: {
            didRouteId: null,
            didRouteRevision: null,
            profileId: null,
            profileRevision: null,
            tenantRevision: null,
          },
          state: 'ended',
          disposition: 'SCREEN',
          createdAt: '2026-09-25T00:00:00Z',
          endedAt: '2026-09-25T00:01:00Z',
        },
        events: [],
        participants: [],
        commands: [],
      },
    }),
  );
  for (const path of ['/runtime', '/runtime/calls', '/runtime/calls/ended-call']) {
    const response = await page.goto(origin + path);
    expect(response?.status()).toBe(200);
    expect(response?.headers()['content-type']).toContain('text/html');
    await expect(
      page.getByRole('heading', {
        name: path.endsWith('ended-call') ? 'Call ended-call' : 'Call History',
        exact: true,
      }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole('heading', {
        name: path.endsWith('ended-call') ? 'Call ended-call' : 'Call History',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^(Refresh|Observe live transcript)$/ }),
    ).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Live transcript' })).toHaveCount(0);
  }
  // Network API calls still reach the real authenticated API, never the SPA.
  const api = await page.request.get(origin + '/runtime/calls?state=recent', {
    headers: { Accept: 'application/json' },
  });
  expect(api.headers()['content-type']).toContain('application/json');
  const unknown = await page.request.get(origin + '/runtime/no-such-api', {
    headers: { Accept: 'text/html' },
  });
  expect(unknown.status()).toBe(404);
  expect((await unknown.json()).error).toBe('not_found');
});
