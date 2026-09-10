import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  adminApi,
  ApiError,
  QUEUE_STRATEGIES,
  type Extension,
  type NativeQueue,
  type QueueMember,
  type QueueStrategy,
} from '../api/admin';
import {
  applyStateLabel,
  COMMITTED_NOTICE,
  PbxDisabledNotice,
  PbxErrorNotice,
} from '../components/PbxNotice';
import { usePbxInventory } from '../hooks/usePbxInventory';

const loadInventory = async (tenant: string) => {
  const [queues, extensions] = await Promise.all([
    adminApi.listQueues(tenant),
    adminApi.listExtensions(tenant),
  ]);
  return {
    ...queues,
    extensions: extensions.extensions,
    provisioningEnabled: queues.provisioningEnabled && extensions.provisioningEnabled,
  };
};
interface MemberDraft {
  selected: boolean;
  penalty: string;
  paused: boolean;
}
function matches(member: QueueMember, extension: Extension) {
  return (
    member.interface === `PJSIP/${extension.id}` ||
    member.interface === `Local/${extension.extension}@${extension.context}`
  );
}
function drafts(queue: NativeQueue, extensions: Extension[]): Record<string, MemberDraft> {
  return Object.fromEntries(
    extensions.map((extension) => {
      const member = queue.members.find((row) => matches(row, extension));
      return [
        extension.id,
        {
          selected: !!member,
          penalty: String(member?.penalty ?? 0),
          paused: member?.paused ?? false,
        },
      ];
    }),
  );
}
export function QueuesScreen() {
  const { tenantId = '' } = useParams();
  return <TenantQueues key={tenantId} tenantId={tenantId} />;
}
function TenantQueues({ tenantId }: { tenantId: string }) {
  const inventory = usePbxInventory(tenantId, loadInventory);
  const [form, setForm] = useState({ name: '', strategy: 'ringall' as QueueStrategy });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<NativeQueue | null>(null);
  const [members, setMembers] = useState<Record<string, MemberDraft>>({});
  const [baseline, setBaseline] = useState<Record<string, MemberDraft>>({});
  const [error, setError] = useState<unknown>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const writable = inventory.data?.provisioningEnabled === true && !inventory.error;
  const extensions =
    inventory.data?.extensions.filter(
      (extension) =>
        extension.extension &&
        extension.id === `${extension.extension}-t${inventory.data?.iTenantId}`,
    ) ?? [];
  const start = () => {
    if (lock.current || !writable) return false;
    lock.current = true;
    setBusy(true);
    setError(null);
    setStatus('');
    return true;
  };
  const finish = () => {
    lock.current = false;
    if (inventory.current()) setBusy(false);
  };
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!start()) return;
    try {
      const result = await adminApi.createQueue(tenantId, form);
      if (!inventory.current()) return;
      setStatus(result.applyState === 'active' ? 'Queue verified active.' : COMMITTED_NOTICE);
      setForm({ name: '', strategy: 'ringall' });
      setOpen(false);
      await inventory.refresh();
    } catch (err) {
      if (inventory.current()) setError(err);
    } finally {
      finish();
    }
  };
  const remove = async (queue: NativeQueue) => {
    if (
      lock.current ||
      !window.confirm(
        `Delete queue ${queue.name}? Its saved memberships will also be removed. DIDs referencing this queue must be updated or removed first.`,
      ) ||
      !start()
    )
      return;
    try {
      await adminApi.deleteQueue(tenantId, queue.id);
      if (!inventory.current()) return;
      setStatus(
        `Queue ${queue.name} deletion committed. Effective Asterisk state has not been verified active.`,
      );
      await inventory.refresh();
    } catch (err) {
      if (inventory.current()) setError(err);
    } finally {
      finish();
    }
  };
  const edit = (queue: NativeQueue) => {
    setEditing(queue);
    const draft = drafts(queue, extensions);
    setMembers(draft);
    setBaseline(draft);
    setError(null);
    setStatus('');
  };
  const saveMembers = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing || !start()) return;
    let applied = 0;
    try {
      // Only changed mappings are submitted. Keep a per-operation baseline if a later request fails.
      for (const extension of extensions) {
        const next = members[extension.id]!;
        const previous = baseline[extension.id]!;
        const changed =
          next.selected !== previous.selected ||
          (next.selected && (next.penalty !== previous.penalty || next.paused !== previous.paused));
        if (!changed) continue;
        if (next.selected)
          await adminApi.setQueueMember(tenantId, editing.id, extension.extension!, {
            penalty: Number(next.penalty),
            paused: next.paused,
            context: extension.context,
          });
        else await adminApi.deleteQueueMember(tenantId, editing.id, extension.extension!);
        if (!inventory.current()) return;
        applied++;
        setBaseline((current) => ({ ...current, [extension.id]: { ...next } }));
      }
      if (!inventory.current()) return;
      setStatus(
        applied
          ? `${applied} membership change${applied === 1 ? '' : 's'} committed. Effective Asterisk state has not been verified active.`
          : 'No membership changes.',
      );
      setEditing(null);
      await inventory.refresh();
    } catch (err) {
      if (inventory.current()) {
        setError(err);
        if (applied)
          setStatus(
            `${applied} membership changes committed before the failure. Save again to apply the remaining changes.`,
          );
        await inventory.refresh();
      }
    } finally {
      finish();
    }
  };
  return (
    <section aria-labelledby="queues-heading">
      <p>
        <Link to="/">← Dashboard</Link>
      </p>
      <h1 id="queues-heading">Queues</h1>
      <p>
        Native OfficePulse queues and saved members. Effective Asterisk activation is verified
        separately.
      </p>
      <PbxErrorNotice error={error || inventory.error} />
      {error instanceof ApiError && error.failure.status === 409 && (
        <p>
          A DID may still reference this queue. Review{' '}
          <Link to={`/tenants/${tenantId}/did-routes`}>DID routes</Link> before deleting it.
        </p>
      )}
      {status && <p role="status">{status}</p>}
      {inventory.data && !inventory.data.provisioningEnabled && <PbxDisabledNotice />}
      {inventory.loading && <p role="status">Loading queues…</p>}
      {inventory.data &&
        (inventory.data.queues.length === 0 ? (
          <p>No native queues yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <caption className="visually-hidden">Queues for this tenant</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Strategy</th>
                  <th scope="col">Saved members</th>
                  <th scope="col">Apply state</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {inventory.data.queues.map((queue) => (
                  <tr key={queue.id}>
                    <td>{queue.name}</td>
                    <td>{queue.strategy}</td>
                    <td>
                      {queue.members.length
                        ? queue.members
                            .map(
                              (member) =>
                                `${member.memberName ?? member.interface} (penalty ${member.penalty}${member.paused ? ', paused' : ''})`,
                            )
                            .join(', ')
                        : 'No members'}
                    </td>
                    <td>{applyStateLabel(queue.applyState)}</td>
                    <td>
                      <button
                        type="button"
                        disabled={busy || !writable}
                        onClick={() => edit(queue)}
                        aria-label={`Edit members of ${queue.name}`}
                      >
                        Members
                      </button>{' '}
                      <button
                        type="button"
                        disabled={busy || !writable}
                        onClick={() => void remove(queue)}
                        aria-label={`Delete queue ${queue.name}`}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      <button
        type="button"
        disabled={busy || inventory.loading}
        onClick={() => void inventory.refresh()}
      >
        Refresh inventory
      </button>{' '}
      <button type="button" disabled={!writable || busy} onClick={() => setOpen(true)}>
        Create queue
      </button>
      {open && (
        <div className="record-editor">
          <h2>Create queue</h2>
          <form onSubmit={(event) => void create(event)}>
            <fieldset disabled={busy || !writable}>
              <legend>Queue details</legend>
              <label>
                Queue name / slug
                <input
                  required
                  maxLength={60}
                  pattern="[a-zA-Z0-9_.\-]{1,60}"
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                />
              </label>
              <small>Use a short name such as reception or sales.</small>
              <label>
                Strategy
                <select
                  value={form.strategy}
                  onChange={(event) =>
                    setForm({ ...form, strategy: event.target.value as QueueStrategy })
                  }
                >
                  {QUEUE_STRATEGIES.map((strategy) => (
                    <option key={strategy}>{strategy}</option>
                  ))}
                </select>
              </label>
            </fieldset>
            <div className="form-actions">
              <button type="submit" disabled={busy || !writable}>
                {busy ? 'Creating…' : 'Save queue'}
              </button>
              <button type="button" disabled={busy} onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
      {editing && (
        <div className="record-editor">
          <h2>Members of {editing.name}</h2>
          <form onSubmit={(event) => void saveMembers(event)}>
            <fieldset disabled={busy || !writable}>
              <legend>Select tenant extensions</legend>
              {extensions.length === 0 && (
                <p>
                  No managed extensions.{' '}
                  <Link to={`/tenants/${tenantId}/extensions`}>Create an extension</Link> first.
                </p>
              )}
              {extensions.map((extension) => {
                const draft = members[extension.id];
                if (!draft) return null;
                return (
                  <fieldset key={extension.id}>
                    <legend>
                      {extension.extension} — {extension.callerId ?? extension.id}
                    </legend>
                    <label>
                      <input
                        type="checkbox"
                        checked={draft.selected}
                        onChange={(event) =>
                          setMembers({
                            ...members,
                            [extension.id]: { ...draft, selected: event.target.checked },
                          })
                        }
                      />
                      Include extension {extension.extension}
                    </label>
                    {draft.selected && (
                      <details>
                        <summary>Advanced member settings for {extension.extension}</summary>
                        <label>
                          Penalty for {extension.extension}
                          <input
                            type="number"
                            required
                            min={0}
                            max={100}
                            step={1}
                            value={draft.penalty}
                            onChange={(event) =>
                              setMembers({
                                ...members,
                                [extension.id]: { ...draft, penalty: event.target.value },
                              })
                            }
                          />
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={draft.paused}
                            onChange={(event) =>
                              setMembers({
                                ...members,
                                [extension.id]: { ...draft, paused: event.target.checked },
                              })
                            }
                          />
                          Paused for {extension.extension}
                        </label>
                      </details>
                    )}
                  </fieldset>
                );
              })}
              {editing.members.some(
                (member) => !extensions.some((extension) => matches(member, extension)),
              ) && <p>Other saved members are operator managed and remain read-only.</p>}
            </fieldset>
            <div className="form-actions">
              <button type="submit" disabled={busy || !writable}>
                {busy ? 'Saving…' : 'Save members'}
              </button>
              <button type="button" disabled={busy} onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
