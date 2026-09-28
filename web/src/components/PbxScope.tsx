import type { NativeInventory } from '../api/admin';

/**
 * Names the routing scope an inventory describes — the PBX instance and the
 * Asterisk context — and offers the tenant's other contexts when it owns
 * more than one. The server refuses any context outside that list.
 */
export function PbxScope({
  inventory,
  context,
  onSelect,
  disabled = false,
}: {
  inventory: Pick<NativeInventory, 'pbxInstanceId' | 'context' | 'contexts'>;
  context: string | undefined;
  onSelect: (context: string) => void;
  disabled?: boolean;
}) {
  return (
    <p className="pbx-scope">
      PBX instance <code>{inventory.pbxInstanceId}</code> · context{' '}
      {inventory.contexts.length > 1 ? (
        <label>
          Context
          <select
            disabled={disabled}
            value={context ?? inventory.context}
            onChange={(event) => onSelect(event.target.value)}
          >
            {inventory.contexts.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
      ) : (
        <code>{inventory.context}</code>
      )}
    </p>
  );
}
