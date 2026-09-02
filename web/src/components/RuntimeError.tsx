import { RuntimeApiError } from '../api/runtime';

/**
 * One rendering for every way a runtime view can fail to load, so a
 * deployment gap reads as the variable an operator has to set rather than
 * as a generic failure.
 */
export function RuntimeErrorNotice({ error }: { error: unknown }) {
  if (error instanceof RuntimeApiError) {
    if (error.missingConfiguration.length > 0) {
      return (
        <p role="alert">
          {error.message} — missing: <code>{error.missingConfiguration.join(', ')}</code>
        </p>
      );
    }
    if (error.status === 403 || error.status === 401) {
      return <p role="alert">{error.message}</p>;
    }
    return (
      <p role="alert">
        {error.message}
        {error.code ? ` (${error.code})` : ''}
      </p>
    );
  }
  return <p role="alert">{error instanceof Error ? error.message : 'Failed to load'}</p>;
}
