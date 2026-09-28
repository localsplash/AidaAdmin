import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminApi, type DidRoute, type TenantNumber } from '../api/admin';
import { applyStateLabel, COMMITTED_NOTICE, PbxErrorNotice } from './PbxNotice';
import type { useNumberRouting } from '../hooks/useNumberRouting';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function selectedDays(value: string): string[] {
  const days = new Set<string>();
  for (const term of value.split('&')) {
    const [start, end] = term.split('-');
    if (!start || !DAYS.includes(start)) continue;
    if (!end) {
      days.add(start);
      continue;
    }
    const finish = DAYS.indexOf(end);
    if (finish < 0) continue;
    for (let day = DAYS.indexOf(start), count = 0; count < 7; day = (day + 1) % 7, count++) {
      days.add(DAYS[day]!);
      if (day === finish) break;
    }
  }
  return DAYS.filter((day) => days.has(day));
}
const EMPTY = {
  did: '',
  queue: '',
  rings: '6',
  scheduled: false,
  start: '09:00',
  end: '17:00',
  days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  timezone: '',
  destination: '',
};
function formFor(route: DidRoute | undefined, did: string) {
  if (!route?.managed) return { ...EMPTY, did };
  const [start, end] = route.schedule?.timeRange.split('-') ?? ['09:00', '17:00'];
  return {
    did,
    queue: route.queue,
    rings: String(route.ringsBeforeAi),
    scheduled: !!route.schedule,
    start: start!,
    end: end!,
    days: route.schedule ? selectedDays(route.schedule.weekdays) : EMPTY.days,
    timezone: route.schedule?.timezone ?? '',
    destination: route.livekitDestination === did ? '' : route.livekitDestination,
  };
}
export function NumberRouting({
  tenantId,
  number,
  route: selected,
  inventory,
  autoExpand,
  identityAvailable,
}: {
  tenantId: string;
  number: TenantNumber;
  route: DidRoute;
  inventory: ReturnType<typeof useNumberRouting>;
  autoExpand: boolean;
  identityAvailable: boolean;
}) {
  const [open, setOpen] = useState(autoExpand);
  const [form, setForm] = useState(() => formFor(selected, number.phoneNumber));
  const routeSnapshot = JSON.stringify(selected);
  const [baseline, setBaseline] = useState(routeSnapshot);
  // Refreshes with unchanged routing preserve drafts. Newly discovered or
  // changed managed settings must replace defaults before another save.
  if (baseline !== routeSnapshot) {
    setBaseline(routeSnapshot);
    setForm(formFor(selected, number.phoneNumber));
  }
  const [error, setError] = useState<unknown>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const writable =
    inventory.data?.provisioningEnabled === true &&
    !inventory.error &&
    !inventory.loading &&
    identityAvailable &&
    number.bEnabled &&
    number.bVoice;
  const configurable = selected.managed || selected.availability === 'unconfigured';
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (lock.current || !writable || !configurable) return;
    setError(null);
    setStatus('');
    if (form.scheduled) {
      if (!form.days.length) {
        setError(new Error('Select at least one weekday.'));
        return;
      }
      try {
        if (
          !form.timezone ||
          form.timezone.length > 64 ||
          (form.timezone !== 'UTC' &&
            !/^[A-Za-z0-9_+.-]+(?:\/[A-Za-z0-9_+.-]+)+$/.test(form.timezone))
        )
          throw new Error();
        new Intl.DateTimeFormat('en', { timeZone: form.timezone }).format();
      } catch {
        setError(new Error('Enter a valid IANA timezone, for example America/Los_Angeles or UTC.'));
        return;
      }
    }
    lock.current = true;
    setBusy(true);
    try {
      const result = await adminApi.saveDidRoute(tenantId, form.did, {
        queue: form.queue,
        ringsBeforeAi: Number(form.rings),
        ...(form.scheduled
          ? {
              schedule: {
                timeRange: `${form.start}-${form.end}`,
                weekdays: DAYS.filter((day) => form.days.includes(day)).join('&'),
                timezone: form.timezone,
              },
            }
          : {}),
        ...(form.destination ? { livekitDestination: form.destination } : {}),
      });
      if (!inventory.current()) return;
      setStatus(
        `${result.applyState === 'active' ? 'DID route verified active.' : COMMITTED_NOTICE} OfficePulse returned a queue timeout of ${result.ringTimeoutSeconds} seconds.`,
      );
      await inventory.refresh();
    } catch (err) {
      if (inventory.current()) setError(err);
    } finally {
      lock.current = false;
      if (inventory.current()) setBusy(false);
    }
  };
  const remove = async (route: DidRoute) => {
    if (
      lock.current ||
      !writable ||
      !route.managed ||
      !window.confirm(
        `Disable managed PBX routing for ${route.did}? This preserves the Identity phone number, carrier service, messages and assistant profile.`,
      )
    )
      return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setStatus('');
    try {
      await adminApi.deleteDidRoute(tenantId, route.did);
      if (!inventory.current()) return;
      setStatus(
        `PBX routing deletion for ${route.did} committed. The Identity phone number is unchanged; effective Asterisk state is unverified.`,
      );
      setForm(formFor(undefined, number.phoneNumber));
      await inventory.refresh();
    } catch (err) {
      if (inventory.current()) setError(err);
    } finally {
      lock.current = false;
      if (inventory.current()) setBusy(false);
    }
  };
  return (
    <div>
      <p>
        <strong>PBX routing: </strong>
        {inventory.error
          ? 'Unavailable'
          : selected.managed
            ? `Configured — ${inventory.data?.queues.find((queue) => queue.id === selected.queue)?.name ?? selected.queue} → LiveKit (${selected.ringTimeoutSeconds} seconds)`
            : selected.availability === 'unconfigured'
              ? 'Unconfigured'
              : selected.availability === 'manual'
                ? 'Manual / operator managed'
                : selected.availability === 'scope_missing'
                  ? 'PBX scope missing'
                  : 'Unavailable'}
      </p>
      {selected.managed && (
        <p>
          {selected.schedule
            ? `${selected.schedule.timeRange}, ${selected.schedule.weekdays}, ${selected.schedule.timezone}`
            : 'Always open'}
          {' · '}
          {applyStateLabel(selected.applyState)}
        </p>
      )}
      {!number.bEnabled && <p>Enable the Identity number before changing PBX routing.</p>}
      {!configurable && (
        <p>
          Routing is read-only. An operator must review this number’s PBX scope or routing before it
          can be configured here.
        </p>
      )}
      <PbxErrorNotice error={error} />
      {status && <p role="status">{status}</p>}
      {configurable && (
        <details
          open={open}
          onToggle={(event) => setOpen(event.currentTarget.open)}
          className="record-editor"
        >
          <summary>{selected.managed ? 'Edit PBX routing' : 'Configure PBX routing'}</summary>
          <form
            aria-label={`PBX routing for ${number.phoneNumber}`}
            onSubmit={(event) => void save(event)}
          >
            <fieldset disabled={busy || !writable || !configurable}>
              <legend>Number and destination</legend>
              <label htmlFor={`did-queue-${number.iPhoneNumberId}`}>Queue</label>
              <select
                id={`did-queue-${number.iPhoneNumberId}`}
                required
                value={form.queue}
                onChange={(event) => setForm({ ...form, queue: event.target.value })}
              >
                <option value="">Choose a native queue…</option>
                {inventory.data?.queues.map((queue) => (
                  <option key={queue.id} value={queue.id}>
                    {queue.name}
                  </option>
                ))}
              </select>
              {inventory.data?.queues.length === 0 && (
                <p>
                  <Link to={`/tenants/${tenantId}/queues`}>Create a queue</Link> first.
                </p>
              )}
              <label>
                Rings before LiveKit
                <input
                  type="number"
                  required
                  min={1}
                  max={12}
                  step={1}
                  value={form.rings}
                  onChange={(event) => setForm({ ...form, rings: event.target.value })}
                />
              </label>
              <p>
                The POC approximates each ring as five seconds: {Number(form.rings) * 5} seconds for
                this form.{' '}
                {selected?.managed && (
                  <>OfficePulse’s saved queue timeout is {selected.ringTimeoutSeconds} seconds.</>
                )}
              </p>
            </fieldset>
            <fieldset disabled={busy || !writable || !configurable}>
              <legend>Business hours</legend>
              <label>
                <input
                  type="checkbox"
                  checked={form.scheduled}
                  onChange={(event) => setForm({ ...form, scheduled: event.target.checked })}
                />
                Enable business-hours schedule
              </label>
              {form.scheduled ? (
                <>
                  <label>
                    Local start time
                    <input
                      type="time"
                      required
                      value={form.start}
                      onChange={(event) => setForm({ ...form, start: event.target.value })}
                    />
                  </label>
                  <label>
                    Local end time
                    <input
                      type="time"
                      required
                      value={form.end}
                      onChange={(event) => setForm({ ...form, end: event.target.value })}
                    />
                  </label>
                  <fieldset>
                    <legend>Weekdays</legend>
                    {DAYS.map((day, index) => (
                      <label key={day}>
                        <input
                          type="checkbox"
                          checked={form.days.includes(day)}
                          onChange={(event) =>
                            setForm({
                              ...form,
                              days: event.target.checked
                                ? [...form.days, day]
                                : form.days.filter((value) => value !== day),
                            })
                          }
                        />
                        {DAY_LABELS[index]}
                      </label>
                    ))}
                  </fieldset>
                  <label>
                    IANA timezone
                    <input
                      required
                      maxLength={64}
                      placeholder="America/Los_Angeles"
                      value={form.timezone}
                      onChange={(event) => setForm({ ...form, timezone: event.target.value })}
                    />
                  </label>
                  <p>
                    During scheduled hours: ring the selected queue, then LiveKit if unanswered.
                    Outside scheduled hours: route directly to LiveKit.
                  </p>
                </>
              ) : (
                <p>With no schedule: the queue is always open, then LiveKit.</p>
              )}
            </fieldset>
            <fieldset disabled={busy || !writable || !configurable}>
              <legend>Advanced routing</legend>
              <details>
                <summary>LiveKit destination override</summary>
                <label>
                  LiveKit destination (optional E.164)
                  <input
                    type="tel"
                    pattern="\+[1-9][0-9]{6,14}"
                    placeholder={form.did || '+15105550100'}
                    value={form.destination}
                    onChange={(event) => setForm({ ...form, destination: event.target.value })}
                  />
                  <small>Defaults to the selected DID.</small>
                </label>
              </details>
            </fieldset>
            <div className="form-actions">
              <button type="submit" disabled={busy || !writable || !configurable}>
                {busy ? 'Saving…' : 'Save DID route'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setForm(formFor(selected, number.phoneNumber))}
              >
                Reset form
              </button>
            </div>
          </form>
        </details>
      )}
      {selected.managed && (
        <button
          type="button"
          disabled={busy || !writable}
          onClick={() => void remove(selected)}
          aria-label={`Disable PBX routing for ${number.phoneNumber}`}
        >
          Disable PBX route
        </button>
      )}
    </div>
  );
}
