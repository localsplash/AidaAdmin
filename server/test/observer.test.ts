import { expect, it } from 'vitest';
import { observerIssuer } from '../src/runtime/observer.js';
it('issues short-lived room-only grants without media or control permissions', async () => {
  const issue = observerIssuer({
    LIVEKIT_URL: 'wss://example.invalid',
    LIVEKIT_API_KEY: 'key',
    LIVEKIT_API_SECRET: 'test-secret-at-least-32-characters',
  })!;
  const result = await issue('room-one');
  const claims = JSON.parse(Buffer.from(result.token.split('.')[1]!, 'base64url').toString());
  expect(claims.exp - claims.nbf).toBeLessThanOrEqual(60);
  expect(claims.video).toEqual({
    room: 'room-one',
    roomJoin: true,
    canSubscribe: false,
    canPublish: false,
    canPublishData: false,
    canUpdateOwnMetadata: false,
    hidden: true,
  });
  expect(claims.sip).toBeUndefined();
  expect(observerIssuer({})).toBeNull();
});
