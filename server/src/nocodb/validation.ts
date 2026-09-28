/** Normalization/validation shared by every NocoDB repository. */

const E164_RE = /^\+[1-9]\d{1,14}$/;
/** Asterisk context grammar shared with OfficePulse (installed 40-char column). */
const CONTEXT_RE = /^[a-zA-Z0-9_.-]{1,40}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export class ValidationError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

/** Returns the validated E.164 number, e.g. +15105551234. */
export function normalizeE164(field: string, value: string): string {
  const bare = value.replace(/[\s()-]/g, '');
  if (!E164_RE.test(bare)) {
    throw new ValidationError(field, `${field} must be an E.164 number like +15105551234`);
  }
  return bare;
}

/** Returns the validated Asterisk context name. */
export function validateContext(field: string, value: string): string {
  if (!CONTEXT_RE.test(value)) {
    throw new ValidationError(field, `${field} must be a valid Asterisk context name`);
  }
  return value;
}

/** The stored comma-separated context list (or an already split one) as names. */
export function splitContexts(value: unknown): string[] {
  const parts = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return parts.map((part) => String(part).trim()).filter((part) => part !== '');
}

export interface TenantContexts {
  /** Primary extension context first, then the additional ones (deduplicated). */
  contexts: string[];
  didContext: string | null;
}

/**
 * A tenant's PBX scope inputs: the primary and additional extension contexts
 * and the shared DID ingress context, which is never one of its extension
 * contexts — that distinction is what keeps DID routes out of business scope.
 */
export function validateTenantContexts(input: {
  asteriskContext: string;
  additionalContexts: readonly string[];
  didContext: string | null;
}): TenantContexts {
  const primary = validateContext('asteriskContext', input.asteriskContext.trim());
  const contexts = [primary];
  for (const context of splitContexts(input.additionalContexts)) {
    validateContext('additionalContexts', context);
    if (!contexts.includes(context)) contexts.push(context);
  }
  const did = input.didContext?.trim() || null;
  const didContext = did === null ? null : validateContext('didContext', did);
  if (didContext !== null && contexts.includes(didContext)) {
    throw new ValidationError(
      'didContext',
      'didContext must be the inbound DID ingress context, not one of this tenant’s extension contexts',
    );
  }
  return { contexts, didContext };
}

export function validateSlug(field: string, value: string): string {
  if (!SLUG_RE.test(value)) {
    throw new ValidationError(field, `${field} must be lowercase letters, digits, and hyphens`);
  }
  return value;
}

export function requireNonEmpty(field: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ValidationError(field, `${field} is required`);
  return trimmed;
}
