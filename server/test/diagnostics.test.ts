import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  buildDiagnostics,
  checkRedirectUriAgainstParentDomain,
  resolveAuthorizeUrl,
  resolveCallbackUri,
} from '../src/diagnostics.js';

const CALLBACK = 'https://admin.aida.localsplash.ai/api/auth/callback';

describe("id's parent-domain rule", () => {
  it('accepts a nested subdomain under the parent domain', () => {
    // The reported failure used this host; subdomain depth is not the cause.
    expect(checkRedirectUriAgainstParentDomain(CALLBACK, 'localsplash.ai')).toEqual({ ok: true });
    expect(checkRedirectUriAgainstParentDomain(CALLBACK, 'aida.localsplash.ai')).toEqual({
      ok: true,
    });
    expect(
      checkRedirectUriAgainstParentDomain(
        'https://localsplash.ai/api/auth/callback',
        'localsplash.ai',
      ),
    ).toEqual({ ok: true });
  });

  it('reports an empty parent domain as the reason', () => {
    const verdict = checkRedirectUriAgainstParentDomain(CALLBACK, '');
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/PARENT_DOMAIN is empty/);
  });

  it('reports whitespace, which id does not trim', () => {
    const verdict = checkRedirectUriAgainstParentDomain(CALLBACK, 'localsplash.ai ');
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/whitespace/);
  });

  it('names the apex domain when the parent domain is one app\u2019s own host', () => {
    // The real misconfiguration: PARENT_DOMAIN set to id.localsplash.ai.
    const verdict = checkRedirectUriAgainstParentDomain(CALLBACK, 'id.localsplash.ai');
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(
      /both hosts sit under localsplash\.ai, so PARENT_DOMAIN is probably meant to be localsplash\.ai/,
    );
  });

  it('offers no apex hint when the domains are unrelated', () => {
    const verdict = checkRedirectUriAgainstParentDomain(CALLBACK, 'example.com');
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).not.toMatch(/probably meant to be/);
  });

  it('rejects a different domain and a suffix-only lookalike', () => {
    expect(checkRedirectUriAgainstParentDomain(CALLBACK, 'localsplash.com').ok).toBe(false);
    // id compares against ".parent", so this must not match.
    expect(
      checkRedirectUriAgainstParentDomain(
        'https://admin.aida.notlocalsplash.ai/cb',
        'localsplash.ai',
      ).ok,
    ).toBe(false);
  });

  it('rejects non-https and credential-bearing URLs', () => {
    expect(
      checkRedirectUriAgainstParentDomain('http://admin.aida.localsplash.ai/cb', 'localsplash.ai')
        .ok,
    ).toBe(false);
    expect(
      checkRedirectUriAgainstParentDomain('https://a:b@admin.localsplash.ai/cb', 'localsplash.ai')
        .ok,
    ).toBe(false);
  });
});

describe('resolved login URLs', () => {
  it('builds the exact redirect_uri and authorize URL', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      PUBLIC_BASE_URL: 'https://admin.aida.localsplash.ai',
      ID_BASE_URL: 'https://id.localsplash.ai',
    });
    expect(resolveCallbackUri(config)).toBe(CALLBACK);
    expect(resolveAuthorizeUrl(config)).toBe(
      `https://id.localsplash.ai/authorize?redirect_uri=${encodeURIComponent(CALLBACK)}`,
    );
  });
});

describe('preflight report', () => {
  const base = {
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'https://admin.aida.localsplash.ai',
    ID_BASE_URL: 'https://id.localsplash.ai',
    SESSION_SECRET: 'x'.repeat(32),
    AIDA_ADMIN_DATABASE_URL: 'postgresql://localhost/aida_admin',
    ID_EVENT_SOURCE_CIDRS: '10.0.0.0/8',
  };

  it('passes when everything needed is configured', () => {
    const report = buildDiagnostics(
      loadConfig({
        ...base,
        ID_PARENT_DOMAIN: 'localsplash.ai',
        NOCODB_BASE_URL: 'https://nocodb.localsplash.ai',
        NOCODB_API_TOKEN: 'token-value',
        NOCODB_BASE_ID: 'p1234567890',
      }),
    );
    expect(report.loginReady).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it('names the id-side parent domain as the blocker', () => {
    const report = buildDiagnostics(loadConfig({ ...base, ID_PARENT_DOMAIN: 'localsplash.com' }));
    expect(report.loginReady).toBe(false);
    const finding = report.findings.find((f) => f.summary.includes('reject this redirect_uri'));
    expect(finding?.fix).toMatch(/PARENT_DOMAIN in id's NocoDB oAuthConfig/);
  });

  it('flags missing login configuration without printing values', () => {
    const report = buildDiagnostics(loadConfig({ NODE_ENV: 'test' }));
    expect(report.loginReady).toBe(false);
    expect(report.findings.map((f) => f.summary).join(' ')).toMatch(/PUBLIC_BASE_URL/);
    expect(report.findings.map((f) => f.summary).join(' ')).toMatch(/ID_BASE_URL/);
    expect(JSON.stringify(report)).not.toContain('x'.repeat(32));
  });

  it('names the missing NocoDB variables that block tenant creation', () => {
    // The reported case: base URL and token present, base id forgotten.
    const report = buildDiagnostics(
      loadConfig({
        ...base,
        ID_PARENT_DOMAIN: 'localsplash.ai',
        NOCODB_BASE_URL: 'https://nocodb.localsplash.ai',
        NOCODB_API_TOKEN: 'token-value',
      }),
    );
    const finding = report.findings.find((f) => f.summary.includes('NocoDB is not configured'));
    expect(finding?.summary).toContain('NOCODB_BASE_ID');
    expect(finding?.summary).not.toContain('NOCODB_BASE_URL');
    expect(finding?.fix).toMatch(/nocodb -w server -- create/);
    expect(JSON.stringify(report)).not.toContain('token-value');
  });

  it('warns about in-memory persistence, unsigned cookies, and a closed event receiver', () => {
    const report = buildDiagnostics(
      loadConfig({
        NODE_ENV: 'test',
        PUBLIC_BASE_URL: 'https://admin.aida.localsplash.ai',
        ID_BASE_URL: 'https://id.localsplash.ai',
        ID_PARENT_DOMAIN: 'localsplash.ai',
      }),
    );
    const summaries = report.findings.map((f) => f.summary).join('\n');
    expect(summaries).toMatch(/SESSION_SECRET/);
    expect(summaries).toMatch(/AIDA_ADMIN_DATABASE_URL/);
    expect(summaries).toMatch(/ID_EVENT_SOURCE_CIDRS/);
    // Warnings alone never block login.
    expect(report.loginReady).toBe(true);
  });
});
