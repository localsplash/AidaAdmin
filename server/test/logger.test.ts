import { describe, expect, it } from 'vitest';
import { REDACT_PATHS } from '../src/logger.js';

describe('logger redaction', () => {
  it('covers credential-bearing request and response fields', () => {
    expect(REDACT_PATHS).toContain('req.headers.authorization');
    expect(REDACT_PATHS).toContain('req.headers.cookie');
    expect(REDACT_PATHS).toContain('res.headers["set-cookie"]');
    expect(REDACT_PATHS).toContain('*.sipSecret');
    expect(REDACT_PATHS).toContain('*.enrollmentToken');
  });
});
