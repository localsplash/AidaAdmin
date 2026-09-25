import { expect, test } from '@playwright/test';
import type { CallDetail } from '../web/src/api/runtime';

const origin = 'http://127.0.0.1:3102';
function detail(id: string): CallDetail {
  return {
    call: {
      id,
      asteriskLinkedId: id,
      officePulseInstanceId: 'test',
      tenantId: '7',
      didE164: '+15555550100',
      callerNumber: id === 'first' ? '+15555550101' : '+15555550102',
      config: {
        didRouteId: null,
        didRouteRevision: null,
        profileId: null,
        profileRevision: null,
        tenantRevision: null,
      },
      roomName: `room-${id}`,
      agentParticipantSid: null,
      destinationType: null,
      destinationId: null,
      disposition: 'SCREEN',
      state: 'screening',
      version: 1,
      createdAt: '2026-09-24T12:00:00Z',
      endedAt: null,
    },
    events: [
      {
        sequenceNumber: 1,
        eventType: 'aida-connected',
        payload: null,
        createdAt: '2026-09-24T12:00:01Z',
      },
    ],
    participants: [],
    commands: [],
  };
}

test('LIVE auto-observes concurrent calls and moves ended calls into Call History', async ({
  page,
  context,
}) => {
  await context.addCookies([{ name: 'aida.sid', value: 'tenant-admin', url: origin }]);
  const first = detail('first');
  const second = detail('second');
  const observed = new Set<string>();
  const states = new Set<string>();
  await page.route('**/runtime/calls?*', (route) => {
    const state = new URL(route.request().url()).searchParams.get('state')!;
    states.add(state);
    return route.fulfill({
      json: {
        calls: [first.call, second.call].filter((call) =>
          state === 'recent' ? call.endedAt : !call.endedAt,
        ),
      },
    });
  });
  await page.route('**/runtime/calls/*?*', (route) =>
    route.fulfill({ json: route.request().url().includes('/first?') ? first : second }),
  );
  await page.route('**/runtime/calls/*/observer', (route) => {
    observed.add(route.request().url().includes('/first/') ? 'first' : 'second');
    return route.fulfill({
      status: 409,
      json: { error: 'agent_not_ready', message: 'Waiting for agent' },
    });
  });
  await page.goto(`${origin}/operations`);
  await expect(page.getByRole('heading', { name: 'LIVE', exact: true })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Primary', exact: true });
  await expect(nav.getByRole('link', { name: 'LIVE', exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Call History', exact: true })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect.poll(() => [...observed].sort()).toEqual(['first', 'second']);
  expect([...states]).toEqual(['active']);
  const indicator = page.locator('.live-call-indicator').first();
  await expect(indicator).toHaveCSS('animation-name', 'live-call-pulse');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(indicator).toHaveCSS('animation-name', 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByRole('tab', { name: 'Live call: +15555550102' }).click();
  await expect(page.getByRole('tabpanel')).toHaveAccessibleName('Live call: +15555550102');
  await page.screenshot({ path: 'test-results/live-concurrent-calls.png', fullPage: true });

  second.call.endedAt = '2026-09-24T12:05:00Z';
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('tabpanel')).toHaveAccessibleName('Live call: +15555550101');
  await nav.getByRole('link', { name: 'Call History', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Call History', exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Call sessions' })).toContainText('+15555550102');
  await expect(page.getByRole('table', { name: 'Call sessions' })).not.toContainText(
    '+15555550101',
  );
  expect(states.has('recent')).toBe(true);
});
