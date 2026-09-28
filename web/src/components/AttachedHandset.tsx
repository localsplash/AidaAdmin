import type { Handset } from '../api/admin';

export const REVOKE_EXPLANATION =
  'The app attaches again automatically if the phone is still registered to this extension; revoke is for a phone that has left, not a lock.';

export function AttachedHandset({
  handset,
  disabled,
  onRevoke,
}: {
  handset: Handset;
  disabled: boolean;
  onRevoke: (handset: Handset) => void;
}) {
  return (
    <div className="attached-handset">
      <dl>
        <dt>Model</dt>
        <dd>{handset.deviceModel || 'Unknown model'}</dd>
        <dt>MAC at attach</dt>
        <dd>{handset.mac ?? 'unknown'}</dd>
        <dt>Local address</dt>
        <dd>{handset.localIp}</dd>
        <dt>Public address</dt>
        <dd>{handset.publicIp}</dd>
        <dt>Last seen</dt>
        <dd>
          <time dateTime={handset.lastSeenAt}>{handset.lastSeenAt}</time>
        </dd>
      </dl>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onRevoke(handset)}
        aria-label={`Revoke handset for extension ${handset.extension ?? handset.endpointId}`}
      >
        Revoke
      </button>
    </div>
  );
}
