import type { NocoBaseInfo, NocoMetaApi } from './api.js';

/** Shared platform base; reads require prior operator bootstrap. */
export const AIDA_BASE_NAME = 'PlatformConfig';

export class BaseResolutionError extends Error {}

function matches(title: string, name: string): boolean {
  return title.trim().toLowerCase() === name.toLowerCase();
}

async function findBase(api: NocoMetaApi, name: string): Promise<NocoBaseInfo | null> {
  const found = (await api.listBases()).filter((base) => matches(base.title, name));
  if (found.length > 1) {
    throw new BaseResolutionError(
      `NocoDB has ${found.length} bases named ${name} (ids: ${found
        .map((b) => b.id)
        .join(', ')}). Exactly one is required — rename or remove the duplicates.`,
    );
  }
  return found[0] ?? null;
}

/**
 * Finds the PlatformConfig base by name, creating it when absent. Ambiguity is
 * never resolved by guessing: two bases sharing the name is an operator
 * error that only an operator can settle.
 */
export async function resolveBaseId(api: NocoMetaApi, create = false): Promise<string> {
  const existing = await findBase(api, AIDA_BASE_NAME);
  if (existing) return existing.id;

  if (!create)
    throw new BaseResolutionError(
      'PlatformConfig is absent; run the explicit configuration bootstrap before starting AidaAdmin',
    );
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
