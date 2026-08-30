import type { AppConfig, ServiceEnvVar } from './config.js';
import { parseCidrList } from './config.js';

/**
 * Login preflight.
 *
 * The `/authorize` round-trip fails on the id side, in a browser, with an
 * opaque 400 when configuration on either side is wrong. These pure checks
 * reproduce id's decision locally so the cause is named before a person has
 * to read someone else's logs. No secret value is ever included in a result.
 */

/** The exact redirect_uri AidaAdmin sends to id, or null when unconfigured. */
export function resolveCallbackUri(config: AppConfig): string | null {
  const base = config.serviceConfig.PUBLIC_BASE_URL;
  if (!base) return null;
  try {
    return new URL('/api/auth/callback', base).toString();
  } catch {
    return null;
  }
}

/** The exact /authorize URL the browser is redirected to, without state. */
export function resolveAuthorizeUrl(config: AppConfig): string | null {
  const idBase = config.serviceConfig.ID_BASE_URL;
  const redirectUri = resolveCallbackUri(config);
  if (!idBase || !redirectUri) return null;
  try {
    const url = new URL('/authorize', idBase);
    url.searchParams.set('redirect_uri', redirectUri);
    return url.toString();
  } catch {
    return null;
  }
}

export type ParentDomainVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Mirrors id's `validateRedirectUri` (localsplash/id src/web.ts): the host
 * must equal PARENT_DOMAIN or end with `.PARENT_DOMAIN`, over https, with no
 * credentials in the URL. Subdomain depth is NOT limited — `a.b.example.com`
 * is as valid as `a.example.com` — so a rejected multi-label host means the
 * configured parent domain is empty, different, or carries stray whitespace
 * (id lowercases and strips leading dots but does not trim).
 */
export function checkRedirectUriAgainstParentDomain(
  redirectUri: string,
  parentDomainRaw: string,
): ParentDomainVerdict {
  if (parentDomainRaw.trim() === '') {
    return {
      ok: false,
      reason: "id's PARENT_DOMAIN is empty — every redirect_uri is rejected until it is set",
    };
  }
  if (parentDomainRaw !== parentDomainRaw.trim()) {
    return {
      ok: false,
      reason:
        'the parent domain has leading or trailing whitespace; id does not trim it, so no host can ever match',
    };
  }

  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return { ok: false, reason: `${redirectUri} is not a valid URL` };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: `${url.protocol}// is rejected; id requires https in production` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'a redirect_uri carrying credentials is rejected' };
  }

  const parentDomain = parentDomainRaw.toLowerCase().replace(/^\.+/, '');
  const host = url.hostname.toLowerCase();
  if (host !== parentDomain && !host.endsWith(`.${parentDomain}`)) {
    return {
      ok: false,
      reason: `host ${host} is not ${parentDomain} and does not end with .${parentDomain}`,
    };
  }
  return { ok: true };
}

export interface Diagnostic {
  level: 'error' | 'warning';
  summary: string;
  fix: string;
}

export interface DiagnosticsReport {
  callbackUri: string | null;
  authorizeUrl: string | null;
  missingConfiguration: ServiceEnvVar[];
  findings: Diagnostic[];
  /** True when nothing blocks a login attempt. */
  loginReady: boolean;
}

/**
 * Checks that could not be inferred from the environment alone are skipped
 * rather than guessed: ID_PARENT_DOMAIN is optional and only enables the
 * redirect_uri check that id itself performs.
 */
export function buildDiagnostics(config: AppConfig): DiagnosticsReport {
  const findings: Diagnostic[] = [];
  const callbackUri = resolveCallbackUri(config);
  const authorizeUrl = resolveAuthorizeUrl(config);

  if (!config.serviceConfig.PUBLIC_BASE_URL) {
    findings.push({
      level: 'error',
      summary: 'PUBLIC_BASE_URL is not set, so no redirect_uri can be built',
      fix: 'Set PUBLIC_BASE_URL to this deployment origin, e.g. https://admin.aida.localsplash.ai',
    });
  } else if (!callbackUri) {
    findings.push({
      level: 'error',
      summary: 'PUBLIC_BASE_URL is not a valid absolute URL',
      fix: 'Use a full origin including the scheme, e.g. https://admin.aida.localsplash.ai',
    });
  } else if (!callbackUri.startsWith('https://') && config.nodeEnv === 'production') {
    findings.push({
      level: 'error',
      summary: 'PUBLIC_BASE_URL is not https; id rejects non-https redirect_uri values',
      fix: 'Serve AidaAdmin over https and set PUBLIC_BASE_URL accordingly',
    });
  }

  if (!config.serviceConfig.ID_BASE_URL) {
    findings.push({
      level: 'error',
      summary: 'ID_BASE_URL is not set, so /api/auth/login cannot redirect to id',
      fix: 'Set ID_BASE_URL, e.g. https://id.localsplash.ai',
    });
  }

  const parentDomain = config.serviceConfig.ID_PARENT_DOMAIN;
  if (parentDomain && callbackUri) {
    const verdict = checkRedirectUriAgainstParentDomain(callbackUri, parentDomain);
    if (!verdict.ok) {
      findings.push({
        level: 'error',
        summary: `id will reject this redirect_uri: ${verdict.reason}`,
        fix: "Set PARENT_DOMAIN in id's NocoDB oAuthConfig table (base id) to the apex domain these apps live under, with no surrounding whitespace",
      });
    }
  } else if (callbackUri) {
    findings.push({
      level: 'warning',
      summary: "id's parent-domain rule was not checked locally (ID_PARENT_DOMAIN is unset)",
      fix: "Set ID_PARENT_DOMAIN to the same value as id's PARENT_DOMAIN to have this preflight verify the redirect_uri",
    });
  }

  if (!config.serviceConfig.SESSION_SECRET) {
    findings.push({
      level: 'warning',
      summary: 'SESSION_SECRET is not set, so session and login-state cookies are unsigned',
      fix: 'Set SESSION_SECRET to a long random value',
    });
  }
  if (!config.serviceConfig.AIDA_ADMIN_DATABASE_URL) {
    findings.push({
      level: 'warning',
      summary:
        'AIDA_ADMIN_DATABASE_URL is not set: sessions, login states, and the identity-event cursor are in memory and are lost on restart',
      fix: 'Point AIDA_ADMIN_DATABASE_URL at the aida_admin PostgreSQL database',
    });
  }
  if (parseCidrList(config.serviceConfig.ID_EVENT_SOURCE_CIDRS).length === 0) {
    findings.push({
      level: 'warning',
      summary: 'ID_EVENT_SOURCE_CIDRS is empty, so POST /id/events rejects every delivery',
      fix: "Set ID_EVENT_SOURCE_CIDRS to id's egress IPv4 CIDRs",
    });
  }

  return {
    callbackUri,
    authorizeUrl,
    missingConfiguration: config.missingServiceConfig,
    findings,
    loginReady: !findings.some((f) => f.level === 'error'),
  };
}
