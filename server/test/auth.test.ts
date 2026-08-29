import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDeps, type AppDeps } from '../src/deps.js';
import type { IdClient, IdEvent, IdRedeemResult } from '../src/id/client.js';
import { createLogger } from '../src/logger.js';

const AUTH_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  ID_BASE_URL: 'https://id.example.invalid',
  PUBLIC_BASE_URL: 'https://admin.example.invalid',
  SESSION_SECRET: 'test-session-secret-value',
};

class FakeIdClient implements IdClient {
  redeemCalls: Array<{ code: string; redirectUri: string }> = [];
  result: IdRedeemResult = {
    user: { iUserId: 42, email: 'person@example.invalid', displayName: 'Pat', superAdmin: true },
    identity: { provider: 'google', subject: 'sub-1' },
    identities: [],
  };

  async redeemCode(code: string, redirectUri: string): Promise<IdRedeemResult> {
    this.redeemCalls.push({ code, redirectUri });
    return this.result;
  }

  async listEvents(_since: number): Promise<IdEvent[]> {
    return [];
  }

  async registerWebhook(): Promise<void> {}

  async ensureDirectoryUser(): Promise<never> {
    throw new Error('unused');
  }

  async getDirectoryUser(): Promise<null> {
    return null;
  }

  async searchDirectoryUsers(): Promise<never[]> {
    return [];
  }
}

function authApp(idClient: IdClient = new FakeIdClient()) {
  const config = loadConfig(AUTH_ENV);
  const deps: AppDeps = { ...createDeps(config), idClient };
  return { app: createApp(config, createLogger(config), deps), deps };
}

async function startLogin(app: ReturnType<typeof authApp>['app']) {
  const res = await request(app).get('/api/auth/login');
  expect(res.status).toBe(302);
  const location = new URL(res.headers.location as string);
  const state = location.searchParams.get('state') as string;
  const cookies = res.headers['set-cookie'] as unknown as string[];
  return { location, state, cookies };
}

describe('login redirect', () => {
  it('redirects to id /authorize with state and the exact callback', async () => {
    const { app } = authApp();
    const { location, state } = await startLogin(app);
    expect(location.origin).toBe('https://id.example.invalid');
    expect(location.pathname).toBe('/authorize');
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://admin.example.invalid/api/auth/callback',
    );
    expect(state).toBeTruthy();
  });

  it('returns 503 when id is not configured', async () => {
    const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
    const app = createApp(config, createLogger(config));
    const res = await request(app).get('/api/auth/login');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('id_not_configured');
  });
});

describe('login callback', () => {
  it('creates a session and redeems with the exact redirect_uri', async () => {
    const idClient = new FakeIdClient();
    const { app } = authApp(idClient);
    const { state, cookies } = await startLogin(app);

    const cb = await request(app)
      .get(`/api/auth/callback?code=one-time-code&state=${encodeURIComponent(state)}`)
      .set('Cookie', cookies);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('/');
    expect(idClient.redeemCalls).toEqual([
      { code: 'one-time-code', redirectUri: 'https://admin.example.invalid/api/auth/callback' },
    ]);

    const sessionCookies = cb.headers['set-cookie'] as unknown as string[];
    const session = await request(app).get('/api/session').set('Cookie', sessionCookies);
    expect(session.status).toBe(200);
    expect(session.body.user.iUserId).toBe(42);
    expect(session.body.user.superAdmin).toBe(true);
  });

  it('rejects a state that does not match the browser cookie', async () => {
    const { app } = authApp();
    const { cookies } = await startLogin(app);
    const res = await request(app)
      .get('/api/auth/callback?code=x&state=forged-state-value')
      .set('Cookie', cookies);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/?login=error');
  });

  it('rejects a replayed state', async () => {
    const { app } = authApp();
    const { state, cookies } = await startLogin(app);
    const url = `/api/auth/callback?code=x&state=${encodeURIComponent(state)}`;
    const first = await request(app).get(url).set('Cookie', cookies);
    expect(first.headers.location).toBe('/');
    const replay = await request(app).get(url).set('Cookie', cookies);
    expect(replay.headers.location).toBe('/?login=error');
  });

  it('routes a network failure during redemption through the login-error flow', async () => {
    const idClient = new FakeIdClient();
    idClient.redeemCode = async () => {
      // What fetch throws when the id host is unreachable.
      throw new TypeError('fetch failed');
    };
    const { app } = authApp(idClient);
    const { state, cookies } = await startLogin(app);
    const res = await request(app)
      .get(`/api/auth/callback?code=x&state=${encodeURIComponent(state)}`)
      .set('Cookie', cookies);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/?login=error');
  });

  it('denies a non-super-admin without an enabled tenant_user record', async () => {
    const idClient = new FakeIdClient();
    // superAdmin comes from the id response only; an admin-looking email must
    // not grant entry.
    idClient.result = {
      user: {
        iUserId: 7,
        email: 'admin@example.invalid',
        displayName: 'Admin-Looking',
        superAdmin: false,
      },
      identity: { provider: 'google', subject: 'sub-7' },
      identities: [],
    };
    const { app } = authApp(idClient);
    const { state, cookies } = await startLogin(app);
    const res = await request(app)
      .get(`/api/auth/callback?code=x&state=${encodeURIComponent(state)}`)
      .set('Cookie', cookies);
    expect(res.headers.location).toBe('/?login=denied');
    const setCookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
    expect(setCookies.join(';')).not.toContain('aida.sid=');
  });
});

describe('logout', () => {
  it('revokes the local session', async () => {
    const { app } = authApp();
    const { state, cookies } = await startLogin(app);
    const cb = await request(app)
      .get(`/api/auth/callback?code=x&state=${encodeURIComponent(state)}`)
      .set('Cookie', cookies);
    const sessionCookies = cb.headers['set-cookie'] as unknown as string[];

    const before = await request(app).get('/api/session').set('Cookie', sessionCookies);
    expect(before.status).toBe(200);
    const csrf = /aida\.csrf=([^;]+)/.exec(before.headers['set-cookie']?.[0] ?? '')?.[1] as string;

    const logout = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', [...sessionCookies, `aida.csrf=${csrf}`])
      .set('x-csrf-token', csrf);
    expect(logout.status).toBe(204);

    const after = await request(app).get('/api/session').set('Cookie', sessionCookies);
    expect(after.status).toBe(401);
  });
});

describe('credential hygiene', () => {
  it('never returns service configuration to the browser', async () => {
    const { app } = authApp();
    const res = await request(app).get('/api/session');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('NOCODB');
    expect(body).not.toContain('SECRET');
    expect(body).not.toContain('id.example.invalid');
  });
});
