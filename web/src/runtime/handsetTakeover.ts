import type { RuntimeCommand, RuntimeEvent } from '../api/runtime';

/** The initial command result can stay 'ringing'; a later bridge event proves takeover. */
export function handsetTakeoverExtension(
  commands: RuntimeCommand[],
  events: RuntimeEvent[],
): string | null {
  let pendingDevice: string | null = null;
  let completedDevice: string | null = null;
  for (const event of [...events].sort((a, b) => a.sequenceNumber - b.sequenceNumber)) {
    if (event.eventType === 'takeover-requested') {
      pendingDevice = typeof event.payload?.deviceId === 'string' ? event.payload.deviceId : null;
    } else if (event.eventType === 'bridged') {
      completedDevice = pendingDevice;
      pendingDevice = null;
    } else if (['takeover-failed', 'fallback', 'hangup'].includes(event.eventType)) {
      pendingDevice = null;
    }
  }
  const command = commands.find(
    (entry) =>
      entry.commandType === 'TAKEOVER' &&
      typeof entry.payload?.deviceId === 'string' &&
      (entry.payload.deviceId === completedDevice ||
        (entry.status === 'completed' && entry.result?.status === 'answered')),
  );
  return typeof command?.payload?.endpointId === 'string' ? command.payload.endpointId : null;
}
