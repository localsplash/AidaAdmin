/**
 * One-time credential display. The values shown here are never persisted by
 * AidaAdmin and cannot be retrieved again — the panel says so explicitly and
 * announces itself to assistive technology.
 */
export function OneTimeSecret({
  title,
  values,
  onDismiss,
}: {
  title: string;
  values: Array<{ label: string; value: string }>;
  onDismiss: () => void;
}) {
  return (
    <section className="one-time-secret" role="alertdialog" aria-label={title} aria-modal="false">
      <h2>{title}</h2>
      <p role="alert">Copy these values now — they are shown once and cannot be retrieved again.</p>
      <dl>
        {values.map((entry) => (
          <div key={entry.label}>
            <dt>{entry.label}</dt>
            <dd>
              <code>{entry.value}</code>
            </dd>
          </div>
        ))}
      </dl>
      <button type="button" onClick={onDismiss}>
        I have copied the values
      </button>
    </section>
  );
}
