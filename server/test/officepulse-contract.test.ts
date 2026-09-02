import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  didPayload,
  extensionCreatePayload,
  extensionUpdatePayload,
  ringGroupPayload,
} from '../src/officepulse/payloads.js';

/**
 * Cross-repository contract (OfficePulse issue #9), seen from this side.
 *
 * `fixtures/officepulse-payloads.json` is a verbatim copy of
 * OfficePulseAidaIntegration's `test/fixtures/aidaadmin-payloads.json` — the
 * bodies its contract test proves it accepts. This test proves our payload
 * builders produce those exact bodies from NocoDB records. When either repo
 * changes a field, one of the two tests fails before a live call does.
 */
const PAYLOADS = JSON.parse(
  readFileSync(new URL('./fixtures/officepulse-payloads.json', import.meta.url), 'utf8'),
) as Record<string, { method: string; path: string; body: Record<string, unknown> }>;

const TENANT = '11111111-1111-4111-8111-111111111111';
const EXT_ID = '22222222-2222-4222-8222-222222222222';

describe('OfficePulse provisioning contract', () => {
  it('builds the extension create body OfficePulse accepts', () => {
    const body = extensionCreatePayload(
      {
        id: EXT_ID,
        tenant_id: TENANT,
        extension_number: '100',
        asterisk_context: 'office-main',
        display_name: 'Front Desk',
        caller_id_name: 'Acme Dental',
        caller_id_number: '+15559870001',
        provisioning_profile: 'grandstream-grp2615',
      },
      TENANT,
    );
    // requestId is the extension id (idempotent create), not a fixture value.
    expect({ ...body, requestId: PAYLOADS.provisionExtension!.body.requestId }).toEqual(
      PAYLOADS.provisionExtension!.body,
    );
  });

  it('sends nullable fields as null, which OfficePulse accepts', () => {
    const body = extensionCreatePayload(
      {
        id: '22222222-2222-4222-8222-222222222223',
        extension_number: '101',
        asterisk_context: 'office-main',
        display_name: 'Back Office',
        caller_id_name: null,
        caller_id_number: '',
      },
      TENANT,
    );
    expect({ ...body, requestId: PAYLOADS.provisionExtensionMinimal!.body.requestId }).toEqual(
      PAYLOADS.provisionExtensionMinimal!.body,
    );
  });

  it('never sends identityUserId to OfficePulse', () => {
    const record = {
      id: EXT_ID,
      identity_user_id: 42,
      extension_number: '100',
      asterisk_context: 'office-main',
      display_name: 'Front Desk',
      enabled: true,
    };
    expect('identityUserId' in extensionCreatePayload(record, TENANT)).toBe(false);
    expect('identityUserId' in extensionUpdatePayload(record)).toBe(false);
    expect(extensionUpdatePayload(record)).toEqual(PAYLOADS.updateExtension!.body);
  });

  it('applies both ring-group caller ID name and number', () => {
    const body = ringGroupPayload(
      TENANT,
      {
        virtual_extension: '600',
        asterisk_context: 'office-main',
        ring_timeout_seconds: 25,
        music_on_hold_class: 'aida-default-tune',
        caller_id_name: 'Acme Reception',
        caller_id_number: '+15559870001',
        enabled: true,
      },
      ['100', '101'],
    );
    expect(body).toEqual(PAYLOADS.provisionRingGroup!.body);
  });

  it('sends the DID with its fail-safe destination, the extended shape', () => {
    const body = didPayload(
      TENANT,
      {
        did_e164: '+15559870002',
        destination_type: 'EXTENSION',
        destination_extension_id: EXT_ID,
        destination_ring_group_id: null,
        enabled: true,
      },
      'aida-inbound',
    );
    expect(body).toEqual(PAYLOADS.provisionDidWithFallback!.body);
    // The pre-#9 shape (no fallback) is what OfficePulse tolerates, not what
    // we send: a DID without its destination has no local fail-safe.
    expect(Object.keys(body)).toEqual(
      expect.arrayContaining(['tenantId', 'destinationType', 'destinationId']),
    );
  });
});
