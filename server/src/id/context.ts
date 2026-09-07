import { AsyncLocalStorage } from 'node:async_hooks';

/** Per-request actor context; never store a bearer token on a shared client. */
export const identityActor = new AsyncLocalStorage<{ token: string | null }>();
