import { expect, test, type BrowserContext, type Page } from '@playwright/test';
const origin = 'http://127.0.0.1:3102';
async function login(context: BrowserContext, token: string) {
  await context.addCookies([{ name: 'aida.sid', value: token, url: origin }]);
}
async function createExtension(page: Page, tenant: number, name: string) {
  await page.goto(`${origin}/tenants/${tenant}/extensions`);
  await page.getByRole('button', { name: 'Create extension', exact: true }).click();
  await page.getByLabel('Extension number').fill('105');
  await page.getByLabel('Display name').fill(name);
  await page.getByRole('button', { name: 'Create extension and show credentials' }).click();
  const disclosure = page.getByRole('alertdialog');
  await expect(disclosure).toContainText(`105-t${tenant}`);
  await expect(disclosure).toContainText('one-time-sip-secret');
  await expect(page.getByRole('button', { name: 'Create extension', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'I have copied the values' }).click();
  await expect(disclosure).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('cell', { name, exact: true })).toBeVisible();
  await expect(page.getByText('one-time-sip-secret')).toHaveCount(0);
}

test('Tenant Admin manages native extension, queue and DID lifecycle within its own tenant', async ({
  page,
  context,
}) => {
  await login(context, 'tenant-admin');
  await createExtension(page, 7, 'Tenant seven desk');
  const crossRead = await page.request.get(`${origin}/admin/tenants/8/extensions`);
  expect(crossRead.status()).toBe(403);
  await page.goto(`${origin}/tenants/8/extensions`);
  await expect(page.getByRole('heading', { name: /access denied/i })).toBeVisible();
  await page.goto(`${origin}/tenants/7/queues`);
  await page.getByRole('button', { name: 'Create queue', exact: true }).click();
  await page.getByLabel('Queue name / slug').fill('reception');
  await page.getByRole('button', { name: 'Save queue', exact: true }).click();
  await expect(page.getByRole('cell', { name: 't7.reception', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit members of t7.reception' }).click();
  await page.getByLabel('Include extension 105').check();
  await page.getByRole('button', { name: 'Save members' }).click();
  await expect(page.getByRole('cell', { name: /105 \(penalty 0\)/ })).toBeVisible();
  await page.goto(`${origin}/tenants/7/did-routes`);
  await page.getByRole('button', { name: 'Configure +15555550107' }).click();
  await page.getByLabel('Queue', { exact: true }).selectOption('t7.reception');
  await page.getByLabel('Enable business-hours schedule').check();
  await page.getByLabel('IANA timezone').fill('America/Los_Angeles');
  await page.getByRole('button', { name: 'Save DID route' }).click();
  await expect(page.getByText(/OfficePulse returned a queue timeout of 30 seconds/)).toBeVisible();
  await expect(page.getByText(/Committed to OfficePulse/)).toContainText(
    /not been verified active/,
  );
  await page.reload();
  await page.getByRole('button', { name: 'Edit +15555550107' }).click();
  await expect(page.getByLabel('IANA timezone')).toHaveValue('America/Los_Angeles');
  await expect(page.getByLabel('Monday')).toBeChecked();
  await page.goto(`${origin}/tenants/7/queues`);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete queue t7.reception' }).click();
  await expect(page.getByRole('alert')).toContainText('DID route');
  await page.goto(`${origin}/tenants/7/did-routes`);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Disable PBX routing for +15555550107' }).click();
  await expect(page.getByRole('button', { name: 'Configure +15555550107' })).toBeVisible();
  await page.goto(`${origin}/tenants/7/queues`);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete queue t7.reception' }).click();
  await expect(page.getByText('No native queues yet.')).toBeVisible();
  await page.goto(`${origin}/tenants/7/extensions`);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete extension 105' }).click();
  await expect(page.getByText('No native extensions yet.')).toBeVisible();
});

test('Super Admin switches tenants and never reuses another tenant form or secret', async ({
  page,
  context,
}) => {
  await login(context, 'super-admin');
  await createExtension(page, 8, 'Tenant eight desk');
  await page.getByLabel('Switch tenant').selectOption('7');
  await expect(page).toHaveURL(`${origin}/tenants/7/extensions`);
  await expect(page.getByRole('heading', { name: 'Extensions', exact: true })).toBeVisible();
  await expect(page.getByText('Tenant eight desk')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect((await page.request.get(`${origin}/admin/tenants/8/extensions`)).status()).toBe(403);
  await page.getByLabel('Switch tenant').selectOption('8');
  await expect(page.getByRole('cell', { name: 'Tenant eight desk', exact: true })).toBeVisible();
  await expect(page.getByText('one-time-sip-secret')).toHaveCount(0);
});
