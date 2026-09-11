import { randomUUID } from 'node:crypto';
import { AccessToken } from 'livekit-server-sdk';
export type ObserverIssuer = (
  room: string,
) => Promise<{ url: string; token: string; expiresIn: number }>;
export function observerIssuer(env: NodeJS.ProcessEnv): ObserverIssuer | null {
  const { LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } = env;
  if (!url || !key || !secret || !url.startsWith('wss://')) return null;
  return async (room) => {
    const token = new AccessToken(key, secret, {
      identity: `admin-observer-${randomUUID()}`,
      ttl: 60,
    });
    token.addGrant({
      room,
      roomJoin: true,
      canSubscribe: false,
      canPublish: false,
      canPublishData: false,
      canUpdateOwnMetadata: false,
      hidden: true,
    });
    return { url, token: await token.toJwt(), expiresIn: 60 };
  };
}
