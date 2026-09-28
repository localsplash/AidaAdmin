/** Disposable browser-test server. No production credentials, SQL or upstream network. */
import { createApp } from '../server/src/app.js';
import { loadConfig } from '../server/src/config.js';
import { createDeps } from '../server/src/deps.js';
import { createLogger } from '../server/src/logger.js';
import {
  HttpIdClient,
  type PlatformTenant,
  type SessionIntrospection,
} from '../server/src/id/client.js';
import { IdentitySessionRepository } from '../server/src/auth/session-store.js';
import { FakeOfficePulse } from '../server/test/helpers/fake-officepulse.js';
import { OfficePulseError, type PbxScope } from '../server/src/officepulse/client.js';
import { createRepos, NocoStore } from '../server/src/nocodb/repos.js';
import { upgradeSchema } from '../server/src/nocodb/schema.js';
import {
  PlatformMembershipRepository,
  PlatformTenantRepository,
} from '../server/src/id/repositories.js';
import { FakeNocoDbApi } from '../server/test/helpers/fake-nocodb.js';
const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
const deps = createDeps(config);
// Tenant 7 owns two extension contexts and an ingress context; 8 has no
// ingress context; 9 has no PlatformConfig scope at all.
const tenants: PlatformTenant[] = [7, 8, 9].map((iTenantId) => ({
  iTenantId,
  name: `Test tenant ${iTenantId}`,
  slug: `tenant-${iTenantId}`,
  role: 'TENANT_ADMIN',
  bEnabled: true,
}));
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
    tenants: superAdmin ? tenants : tenants.filter((tenant) => tenant.iTenantId === 7),
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
      bMessaging: true,
      bEnabled: true,
      accessPolicy: 'TENANT_MEMBERS',
      iVersion: 1,
    },
  ],
});
// The tenant directory backs the Tenants screen; PBX scope comes from PlatformConfig.
identity.directoryRequest = async <T>(path: string): Promise<T> => {
  if (path !== 'tenants') throw new Error(`Unexpected Identity directory call ${path}`);
  return { tenants } as T;
};
const api = new FakeOfficePulse();
// Keep the test's native state realistic through inventory refreshes: queue
// members are the context-scoped SIP endpoints OfficePulse creates.
const endpoint = (scope: PbxScope, ext: string) => `PJSIP/${ext}-${scope.context}`;
const queueRow = (scope: PbxScope, queue: string) =>
  api.queues.get(scope.context)!.find((item) => item.id === queue)!;
const saveMember = api.putQueueMember.bind(api);
api.putQueueMember = async (scope, queue, ext, body, cid) => {
  const result = await saveMember(scope, queue, ext, body, cid);
  const row = queueRow(scope, queue);
  row.members = [
    ...row.members.filter((member) => member.interface !== endpoint(scope, ext)),
    {
      interface: endpoint(scope, ext),
      memberName: ext,
      penalty: body.penalty ?? 0,
      paused: body.paused ?? false,
    },
  ];
  return result;
};
const deleteMember = api.deleteQueueMember.bind(api);
api.deleteQueueMember = async (scope, queue, ext, cid) => {
  await deleteMember(scope, queue, ext, cid);
  const row = queueRow(scope, queue);
  row.members = row.members.filter((member) => member.interface !== endpoint(scope, ext));
};
const deleteQueue = api.deleteQueue.bind(api);
api.deleteQueue = async (scope, queue, cid) => {
  if (api.dids.get(scope.context)?.some((did) => did.managed && did.queue === queue))
    throw new OfficePulseError('Referenced DID', 409);
  await deleteQueue(scope, queue, cid);
};
// PlatformConfig holds each tenant's scope; Numbers uses the central
// membership repository through the admin guard.
const noco = new FakeNocoDbApi();
await upgradeSchema(noco);
const store = new NocoStore(noco);
await store.create('tenant_profile', {
  tenant_id: 7,
  asterisk_context: 'acme',
  additional_contexts: 'acme-branch',
  did_context: 'from-carrier',
});
await store.create('tenant_profile', {
  tenant_id: 8,
  asterisk_context: 'globex',
  additional_contexts: '',
  did_context: null,
});
deps.repos = createRepos(noco, {
  tenants: new PlatformTenantRepository(identity, store),
  tenantUsers: new PlatformMembershipRepository(identity),
  audit: { append: async () => {} },
});
deps.idClient = identity;
deps.sessionStore = new IdentitySessionRepository(identity);
deps.officePulse = api;
deps.audit = { append: async () => {} };
createApp(config, createLogger(config), deps).listen(3102, '127.0.0.1');
