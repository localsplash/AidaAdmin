import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { CSRF_COOKIE, CSRF_HEADER } from '../src/middleware/csrf.js';

function testApp(extraEnv: NodeJS.ProcessEnv = {}) {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal', ...extraEnv });
  return createApp(config, createLogger(config));
}

describe('health endpoints', () => {
  it('reports liveness', async () => {
    const res = await request(testApp()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('reports readiness with missing configuration names only', async () => {
    const res = await request(testApp()).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body.missingConfiguration).toContain('NOCODB_API_TOKEN');
    expect(JSON.stringify(res.body)).not.toContain('value-for-');
  });
});

describe('correlation IDs', () => {
  it('echoes a well-formed inbound correlation ID', async () => {
    const res = await request(testApp())
      .get('/api/session')
      .set('x-correlation-id', 'inbound-correlation-1234');
    expect(res.headers['x-correlation-id']).toBe('inbound-correlation-1234');
  });

  it('replaces a malformed correlation ID', async () => {
    const res = await request(testApp())
      .get('/api/session')
      .set('x-correlation-id', 'bad value with spaces');
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('session endpoint', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(testApp()).get('/api/session');
    expect(res.status).toBe(401);
    expect(res.body.authenticated).toBe(false);
  });

  it('returns the fake session only when explicitly enabled outside production', async () => {
    const res = await request(testApp({ E2E_FAKE_SESSION: 'true' })).get('/api/session');
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.user.superAdmin).toBe(true);
  });
});

describe('CSRF protection', () => {
  it('rejects a mutating API request without a token', async () => {
    const res = await request(testApp()).post('/api/anything');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('csrf_token_invalid');
  });

  it('rejects a mismatched token', async () => {
    const res = await request(testApp())
      .post('/api/anything')
      .set('Cookie', `${CSRF_COOKIE}=token-a`)
      .set(CSRF_HEADER, 'token-b');
    expect(res.status).toBe(403);
  });

  it('accepts a matching double-submit token pair', async () => {
    const app = testApp();
    const sessionRes = await request(app).get('/api/session');
    const setCookie = sessionRes.headers['set-cookie']?.[0] ?? '';
    const token = /aida\.csrf=([^;]+)/.exec(setCookie)?.[1];
    expect(token).toBeTruthy();
    const res = await request(app)
      .post('/api/anything')
      .set('Cookie', `${CSRF_COOKIE}=${token}`)
      .set(CSRF_HEADER, token as string);
    // Passes CSRF and reaches the API 404 handler — not the 403 CSRF rejection.
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });
});

describe('unknown API routes', () => {
  it('returns a safe JSON 404', async () => {
    const res = await request(testApp()).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
    expect(res.body.correlationId).toBeTruthy();
  });
});
