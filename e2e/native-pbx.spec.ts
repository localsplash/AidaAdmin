import { expect, test, type BrowserContext, type Page } from '@playwright/test';
const origin = 'http://127.0.0.1:3102';
async function login(context: BrowserContext, token: string) {
  await context.addCookies([{ name: 'aida.sid', value: token, url: origin }]);
}
/** Creates extension 105 in `context`, choosing it from the selector when the tenant owns several. */
async function createExtension(
  page: Page,
  tenant: number,
  context: string,
  name: string,
  select = false,
) {
  await page.goto(`${origin}/tenants/${tenant}/extensions`);
  if (select)
    await page.getByRole('combobox', { name: 'Context', exact: true }).selectOption(context);
  await page.getByRole('button', { name: 'Create extension', exact: true }).click();
  await page.getByLabel('Extension number').fill('105');
  await page.getByLabel('Display name').fill(name);
  await page.getByRole('button', { name: 'Create extension and show credentials' }).click();
  const disclosure = page.getByRole('alertdialog');
  await expect(disclosure).toContainText(`105-${context}`);
  await expect(disclosure).toContainText('one-time-sip-secret');
  await expect(page.getByRole('button', { name: 'Create extension', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'I have copied the values' }).click();
  await expect(disclosure).toHaveCount(0);
  await page.reload();
  if (select)
    await page.getByRole('combobox', { name: 'Context', exact: true }).selectOption(context);
  await expect(page.getByRole('cell', { name, exact: true })).toBeVisible();
  await expect(page.getByText('one-time-sip-secret')).toHaveCount(0);
}
/** The stored assignments as `context:did` keys, read back through the BFF. */
async function assignmentKeys(page: Page, tenant: number) {
  const res = await page.request.get(`${origin}/admin/tenants/${tenant}/profile-assignments`);
  const body = (await res.json()) as {
    pbxInstanceId: string | null;
    assignments: Array<{ context: string; did: string; enabled: boolean }>;
  };
  return body.assignments
    .filter((row) => row.enabled)
    .map((row) => `${body.pbxInstanceId}/${row.context}:${row.did}`)
    .sort();
}

test('Tenant Admin manages extensions, queues, DID routes and profile assignments within its own contexts', async ({
  page,
  context,
}) => {
  await login(context, 'tenant-admin');
  await createExtension(page, 7, 'acme', 'Tenant seven desk');
  await expect(page.locator('.tenant-banner')).toContainText('PBX context acme');
  // The same extension number is a distinct object in the tenant's second context.
  await createExtension(page, 7, 'acme-branch', 'Branch desk', true);
  await page.getByRole('combobox', { name: 'Context', exact: true }).selectOption('acme');
  await expect(page.getByRole('cell', { name: 'Tenant seven desk', exact: true })).toBeVisible();
  await expect(page.getByText('Branch desk')).toHaveCount(0);
  // Another tenant's context and the shared ingress context are refused before OfficePulse.
  for (const forbidden of ['globex', 'from-carrier']) {
    const refused = await page.request.get(
      `${origin}/admin/tenants/7/extensions?context=${forbidden}`,
    );
    expect(refused.status()).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe('context_forbidden');
  }
  const crossRead = await page.request.get(`${origin}/admin/tenants/8/extensions`);
  expect(crossRead.status()).toBe(403);
  await page.goto(`${origin}/tenants/8/extensions`);
  await expect(page.getByRole('heading', { name: /access denied/i })).toBeVisible();
  await page.goto(`${origin}/tenants/7/queues`);
  await page.getByRole('button', { name: 'Create queue', exact: true }).click();
  await page.getByLabel('Queue name / slug').fill('reception');
  await page.getByRole('button', { name: 'Save queue', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'acme.reception', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit members of acme.reception' }).click();
  await page.getByLabel('Include extension 105').check();
  await page.getByRole('button', { name: 'Save members' }).click();
  await expect(page.getByRole('cell', { name: /105 \(penalty 0\)/ })).toBeVisible();
  await page.goto(`${origin}/tenants/7/numbers`);
  await page.getByLabel('Queue', { exact: true }).selectOption('acme.reception');
  await page.getByLabel('Enable business-hours schedule').check();
  await page.getByLabel('IANA timezone').fill('America/Los_Angeles');
  await page.getByRole('button', { name: 'Save DID route' }).click();
  await expect(page.getByText(/OfficePulse returned a queue timeout of 30 seconds/)).toBeVisible();
  await expect(page.getByText(/Committed to OfficePulse/)).toContainText(
    /not been verified active/,
  );
  await page.reload();
  await expect(page.getByLabel('IANA timezone')).toHaveValue('America/Los_Angeles');
  await expect(page.getByLabel('Monday')).toBeChecked();
  // A context default and a DID-specific assignment, both pinned to the PBX instance.
  await page.goto(`${origin}/tenants/7/profiles`);
  await page.getByLabel('Profile name', { exact: true }).fill('Front desk');
  await page.getByLabel('Business name', { exact: true }).fill('Acme');
  await page.getByLabel('Prompt', { exact: true }).fill('Answer as the Acme front desk.');
  await page.getByRole('button', { name: 'Create profile', exact: true }).click();
  await expect(page.getByText('Created profile Front desk')).toBeVisible();
  const contextDefault = page.getByLabel('Default profile for context acme', { exact: true });
  await contextDefault.selectOption({ label: 'Front desk' });
  await page
    .locator('form', { has: contextDefault })
    .getByRole('button', { name: 'Save assistant profile' })
    .click();
  await expect.poll(() => assignmentKeys(page, 7)).toEqual(['officepulse-test/acme:']);
  await page.goto(`${origin}/tenants/7/numbers`);
  const didProfile = page.getByLabel('Assistant profile', { exact: true });
  await expect(didProfile).toHaveValue('');
  await didProfile.selectOption({ label: 'Front desk' });
  await page
    .locator('form', { has: didProfile })
    .getByRole('button', { name: 'Save assistant profile' })
    .click();
  await expect
    .poll(() => assignmentKeys(page, 7))
    .toEqual(['officepulse-test/acme:', 'officepulse-test/acme:+15555550107']);
  await page.reload();
  await expect(page.getByLabel('Assistant profile', { exact: true })).not.toHaveValue('');
  await page.goto(`${origin}/tenants/7/queues`);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete queue acme.reception' }).click();
  await expect(page.getByRole('alert')).toContainText('DID route');
  await page.goto(`${origin}/tenants/7/numbers`);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Disable PBX routing for +15555550107' }).click();
  await expect(page.getByText('Configure PBX routing', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '+15555550107', exact: true })).toBeVisible();
  await page.goto(`${origin}/tenants/7/queues`);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete queue acme.reception' }).click();
  await expect(page.getByText('No native queues yet.')).toBeVisible();
  await page.goto(`${origin}/tenants/7/extensions`);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete extension 105' }).click();
  await expect(page.getByText('No native extensions yet.')).toBeVisible();
  await page.getByRole('combobox', { name: 'Context', exact: true }).selectOption('acme-branch');
  await expect(page.getByRole('cell', { name: 'Branch desk', exact: true })).toBeVisible();
});

test('Super Admin switches tenants, sees each scope and the scope-missing refusals, never another tenant form or secret', async ({
  page,
  context,
}) => {
  await login(context, 'super-admin');
  await createExtension(page, 8, 'globex', 'Tenant eight desk');
  await expect(page.locator('.tenant-banner')).toContainText('PBX context globex');
  // One context: named, not offered as a choice.
  await expect(page.getByRole('combobox', { name: 'Context', exact: true })).toHaveCount(0);
  await page.getByLabel('Switch tenant').selectOption('7');
  await expect(page).toHaveURL(`${origin}/tenants/7/extensions`);
  await expect(page.getByRole('heading', { name: 'Extensions', exact: true })).toBeVisible();
  await expect(page.locator('.tenant-banner')).toContainText('PBX context acme');
  await expect(page.getByText('Tenant eight desk')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect((await page.request.get(`${origin}/admin/tenants/8/extensions`)).status()).toBe(403);
  await page.getByLabel('Switch tenant').selectOption('8');
  await expect(page.getByRole('cell', { name: 'Tenant eight desk', exact: true })).toBeVisible();
  await expect(page.getByText('one-time-sip-secret')).toHaveCount(0);
  // Tenant 8 has extension scope but no ingress context: DID routes stop with a named refusal.
  await page.goto(`${origin}/tenants/8/numbers`);
  await expect(page.getByRole('alert')).toContainText(
    "Assign this tenant's inbound DID context first",
  );
  // Tenant 9 has no PlatformConfig scope at all: nothing is offered or sent to OfficePulse.
  await page.getByLabel('Switch tenant').selectOption('9');
  await expect(page).toHaveURL(`${origin}/tenants/9/numbers`);
  await expect(page.locator('.tenant-banner')).toContainText('PBX context not assigned');
  await expect(page.getByRole('alert')).toContainText(
    "Assign this tenant's Asterisk context in Tenants first",
  );
  await page.goto(`${origin}/tenants/9/extensions`);
  await expect(page.getByRole('alert')).toContainText(
    "Assign this tenant's Asterisk context in Tenants first",
  );
  await expect(page.getByRole('button', { name: 'Create extension', exact: true })).toBeDisabled();
  await page.goto(`${origin}/tenants/9/profiles`);
  await expect(
    page.getByText('Assign this tenant’s Asterisk context in Tenants first.'),
  ).toBeVisible();
});
