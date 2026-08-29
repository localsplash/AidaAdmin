/** Normalization/validation shared by every NocoDB repository. */

const E164_RE = /^\+[1-9]\d{1,14}$/;
const CONTEXT_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/i;
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

/** Returns the normalized MAC: 12 uppercase hex characters, no separators. */
export function normalizeMac(field: string, value: string): string {
  const bare = value.replace(/[:.\s-]/g, '').toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(bare)) {
    throw new ValidationError(field, `${field} must be 12 hexadecimal characters`);
  }
  return bare;
}

export function validateContext(field: string, value: string): string {
  if (!CONTEXT_RE.test(value)) {
    throw new ValidationError(field, `${field} must be a valid Asterisk context name`);
  }
  return value;
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
