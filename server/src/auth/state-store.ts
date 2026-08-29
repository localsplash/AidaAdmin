import { randomBytes } from 'node:crypto';

const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Single-use login state values (CSRF protection for the /authorize
 * round-trip). A state is valid for one callback within the TTL; replaying a
 * consumed or expired state fails.
 */
export class LoginStateStore {
  private readonly states = new Map<string, number>();

  issue(): string {
    const state = randomBytes(32).toString('base64url');
    this.states.set(state, Date.now() + STATE_TTL_MS);
    return state;
  }

  consume(state: string): boolean {
    const expiresAt = this.states.get(state);
    if (expiresAt === undefined) return false;
    this.states.delete(state);
    return expiresAt >= Date.now();
  }
}
