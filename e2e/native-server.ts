/** Disposable browser-test server. No production credentials, SQL or upstream network. */
import { createApp } from '../server/src/app.js';
import { loadConfig } from '../server/src/config.js';
import { createDeps } from '../server/src/deps.js';
import { createLogger } from '../server/src/logger.js';
import { HttpIdClient, type SessionIntrospection } from '../server/src/id/client.js';
import { IdentitySessionRepository } from '../server/src/auth/session-store.js';
import { FakeOfficePulse } from '../server/test/helpers/fake-officepulse.js';
import { OfficePulseError } from '../server/src/officepulse/client.js';
const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
const deps = createDeps(config);
const selected = new Map([
  ['tenant-admin', 7],
  ['super-admin', 8],
]);
const identity = new HttpIdClient('https://unused.invalid');
identity.introspectSession = async (token): Promise<SessionIntrospection> => {
  if (!selected.has(token)) return { active: false };
  const superAdmin = token === 'super-admin';
  return {
    active: true,
    user: { iUserId: superAdmin ? 2 : 1, email: null, displayName: token, superAdmin },
    selectedTenantId: selected.get(token)!,
    tenants: (superAdmin ? [7, 8] : [7]).map((iTenantId) => ({
      iTenantId,
      name: `Test tenant ${iTenantId}`,
      slug: `tenant-${iTenantId}`,
      role: 'TENANT_ADMIN',
      bEnabled: true,
    })),
  };
};
identity.selectTenant = async (token, tenant) => {
  if (tenant && (token === 'super-admin' || tenant === 7)) selected.set(token, tenant);
};
identity.listTenantNumbers = async (tenant) => ({
  numbers: [
    {
      iPhoneNumberId: Number(tenant),
      iTenantId: Number(tenant),
      phoneNumber: `+1555555010${tenant}`,
      label: 'Test voice number',
      bVoice: true,
      bMessaging: false,
      bEnabled: true,
      accessPolicy: 'TENANT_MEMBERS',
      iVersion: 1,
    },
  ],
});
const api = new FakeOfficePulse();
for (const id of [7, 8])
  api.dids.set(id, [
    {
      did: `+1555555010${id}`,
      managed: false,
      availability: 'unconfigured',
      applyState: 'unknown',
    },
  ]);
// Keep the test's native state realistic through inventory refreshes.
const saveMember = api.putQueueMember.bind(api);
api.putQueueMember = async (id, queue, ext, body, cid) => {
  const result = await saveMember(id, queue, ext, body, cid);
  const row = api.queues.get(id)!.find((item) => item.id === queue)!;
  row.members = [
    ...row.members.filter((member) => member.interface !== `PJSIP/${ext}-t${id}`),
    {
      interface: `PJSIP/${ext}-t${id}`,
      memberName: ext,
      penalty: body.penalty ?? 0,
      paused: body.paused ?? false,
    },
  ];
  return result;
};
const deleteMember = api.deleteQueueMember.bind(api);
api.deleteQueueMember = async (id, queue, ext, cid) => {
  await deleteMember(id, queue, ext, cid);
  const row = api.queues.get(id)!.find((item) => item.id === queue)!;
  row.members = row.members.filter((member) => member.interface !== `PJSIP/${ext}-t${id}`);
};
const deleteQueue = api.deleteQueue.bind(api);
api.deleteQueue = async (id, queue, cid) => {
  if (api.dids.get(id)?.some((did) => did.managed && did.queue === queue))
    throw new OfficePulseError('Referenced DID', 409);
  await deleteQueue(id, queue, cid);
};
deps.idClient = identity;
deps.sessionStore = new IdentitySessionRepository(identity);
deps.officePulse = api;
deps.audit = { append: async () => {} };
createApp(config, createLogger(config), deps).listen(3102, '127.0.0.1');
