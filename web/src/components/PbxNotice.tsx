import { ApiError, type ApplyState } from '../api/admin';

export const COMMITTED_NOTICE =
  'Committed to OfficePulse. Effective Asterisk state has not been verified active.';
export function applyStateLabel(state: ApplyState | undefined): string {
  if (state === 'active') return 'Verified active';
  if (state === 'committed') return 'Committed; activation unverified';
  return 'Activation unknown';
}
export function PbxErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const failure = error instanceof ApiError ? error.failure : null;
  const category =
    failure?.status === 409
      ? 'Conflict'
      : failure?.status === 422 || failure?.status === 400
        ? 'Validation'
        : failure?.status === 503 || failure?.status === 502 || failure?.status === 504
          ? 'OfficePulse unavailable'
          : failure?.status === 404
            ? 'Unavailable record'
            : 'Request failed';
  return (
    <p role="alert">
      {category}:{' '}
      {error instanceof Error
        ? error.message
        : 'Could not complete the request. Refresh and try again.'}
      {failure?.correlationId ? (
        <>
          {' '}
          Support reference: <code>{failure.correlationId}</code>.
        </>
      ) : null}
    </p>
  );
}
export function PbxDisabledNotice() {
  return (
    <p role="status">
      OfficePulse PBX changes are disabled for this tenant. Inventory is read-only.
    </p>
  );
}
