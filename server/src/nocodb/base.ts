import type { NocoBaseInfo, NocoMetaApi } from './api.js';

/**
 * The AidaAdmin base is addressed by NAME, not by a configured id.
 *
 * A NocoDB base id is an opaque per-instance value that nobody can know
 * before the base exists, so requiring it as configuration guarantees a
 * broken first deployment. The name is knowable, stable, and identical on
 * every instance — so it is hardcoded here and the id is discovered at
 * startup and held for the process lifetime.
 *
 * Exactly one base may carry the name. Matching ignores case, because
 * NocoDB preserves whatever capitalisation the base was created with and an
 * operator should not have to guess it.
 */
export const AIDA_BASE_NAME = 'AidaAdmin';

export class BaseResolutionError extends Error {}

function matches(title: string): boolean {
  return title.trim().toLowerCase() === AIDA_BASE_NAME.toLowerCase();
}

/**
 * Finds the base by name, creating it when absent. Ambiguity is never
 * resolved by guessing: two bases sharing the name is an operator error
 * that only an operator can settle.
 */
export async function resolveBaseId(api: NocoMetaApi): Promise<string> {
  const bases = await api.listBases();
  const found = bases.filter((base) => matches(base.title));

  if (found.length > 1) {
    throw new BaseResolutionError(
      `NocoDB has ${found.length} bases named ${AIDA_BASE_NAME} (ids: ${found
        .map((b) => b.id)
        .join(', ')}). Exactly one is required — rename or remove the duplicates.`,
    );
  }

  const existing = found[0];
  if (existing) return existing.id;

  let created: NocoBaseInfo;
  try {
    created = await api.createBase(AIDA_BASE_NAME);
  } catch (err) {
    throw new BaseResolutionError(
      `No NocoDB base named ${AIDA_BASE_NAME} exists and it could not be created ` +
        `(${err instanceof Error ? err.message : String(err)}). Create a base named ` +
        `${AIDA_BASE_NAME}, or use an API token with base-creation rights.`,
    );
  }
  return created.id;
}

/**
 * Resolves once and caches. A failed attempt is not cached, so a NocoDB
 * outage at boot is retried on the next call rather than disabling
 * configuration for the life of the process.
 */
export class CachedBaseResolver {
  private pending: Promise<string> | null = null;
  private resolved: string | null = null;

  constructor(private readonly load: () => Promise<string>) {}

  get baseId(): string | null {
    return this.resolved;
  }

  resolve(): Promise<string> {
    if (this.resolved) return Promise.resolve(this.resolved);
    if (!this.pending) {
      this.pending = this.load()
        .then((id) => {
          this.resolved = id;
          return id;
        })
        .finally(() => {
          this.pending = null;
        });
    }
    return this.pending;
  }
}
