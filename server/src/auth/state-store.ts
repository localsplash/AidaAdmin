import { randomBytes } from 'node:crypto';

export const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Single-use login state values (CSRF protection for the /authorize
 * round-trip). A state is valid for one callback within the TTL; replaying a
 * consumed or expired state fails. Backed by PostgreSQL (`auth_state`) when
 * configured, memory otherwise.
 */
export interface AuthStateRepository {
  issue(): Promise<string>;
  consume(state: string): Promise<boolean>;
}

export class MemoryAuthStateRepository implements AuthStateRepository {
  private readonly states = new Map<string, number>();

  async issue(): Promise<string> {
    const state = randomBytes(32).toString('base64url');
    this.states.set(state, Date.now() + STATE_TTL_MS);
    return state;
  }

  async consume(state: string): Promise<boolean> {
    const expiresAt = this.states.get(state);
    if (expiresAt === undefined) return false;
    this.states.delete(state);
    return expiresAt >= Date.now();
  }
}
