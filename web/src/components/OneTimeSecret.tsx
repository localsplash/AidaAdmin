import { useEffect, useRef, useState } from 'react';

/** The parent clears credentials on dismissal and on tenant change; nothing persists them. */
export function OneTimeSecret({
  title,
  values,
  onDismiss,
}: {
  title: string;
  values: Array<{ label: string; value: string }>;
  onDismiss: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const [copyStatus, setCopyStatus] = useState('');
  useEffect(() => {
    panel.current?.focus();
  }, []);
  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus(`${label} copied.`);
    } catch {
      setCopyStatus('Clipboard is unavailable. Select and copy the value manually.');
    }
  };
  return (
    <section
      ref={panel}
      tabIndex={-1}
      className="one-time-secret"
      role="alertdialog"
      aria-label={title}
      aria-describedby="credential-warning"
      aria-modal="false"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onDismiss();
      }}
    >
      <h2>{title}</h2>
      <p id="credential-warning">
        Copy these values now — they are shown once and cannot be retrieved again. Losing the secret
        requires a future secret rotation capability, which is outside this release.
      </p>
      <dl>
        {values.map((entry) => (
          <div key={entry.label}>
            <dt>{entry.label}</dt>
            <dd>
              <code>{entry.value}</code>{' '}
              <button type="button" onClick={() => void copy(entry.label, entry.value)}>
                Copy {entry.label}
              </button>
            </dd>
          </div>
        ))}
      </dl>
      {copyStatus && <p role="status">{copyStatus}</p>}
      <button type="button" onClick={onDismiss}>
        I have copied the values
      </button>
    </section>
  );
}
