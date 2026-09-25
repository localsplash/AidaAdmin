export interface Segment {
  key: string;
  sequence: number;
  text: string;
  isFinal: boolean;
  speaker: 'caller' | 'assistant';
}

export function mergeTranscript(rows: Segment[], row: Segment): Segment[] {
  const old = rows.find((entry) => entry.key === row.key);
  if (
    old &&
    (old.sequence > row.sequence ||
      (old.isFinal && !row.isFinal) ||
      (old.sequence === row.sequence && old.text === row.text && old.isFinal === row.isFinal))
  )
    return rows;
  return old ? rows.map((entry) => (entry.key === row.key ? row : entry)) : [...rows, row];
}

export function parseHistory(json: string, callId: string): Segment[] {
  const snapshot = JSON.parse(json);
  if (snapshot.callId !== callId || !Array.isArray(snapshot.items)) {
    throw new Error('Invalid transcript history');
  }
  let rows: Segment[] = [];
  for (const item of snapshot.items) {
    if (!['user', 'assistant'].includes(item.role)) continue;
    if (
      typeof item.segment_id !== 'string' ||
      !item.segment_id ||
      !Array.isArray(item.content) ||
      !item.content.every((text: unknown) => typeof text === 'string') ||
      !Number.isSafeInteger(item.sequence) ||
      item.sequence < 0 ||
      typeof item.is_final !== 'boolean'
    )
      throw new Error('Invalid transcript item');
    rows = mergeTranscript(rows, {
      key: item.segment_id,
      sequence: item.sequence,
      text: item.content.join('\n'),
      isFinal: item.is_final,
      speaker: item.role === 'user' ? 'caller' : 'assistant',
    });
  }
  return rows;
}

/** Each page belongs to one frozen snapshot, even while new turns are committed. */
export async function loadTranscriptHistory(
  rpc: (payload: string) => Promise<string>,
  callId: string,
  current: () => boolean,
): Promise<Segment[]> {
  let text = '';
  let snapshotId: string | undefined;
  for (;;) {
    if (!current()) return [];
    const page = JSON.parse(await rpc(JSON.stringify({ offset: text.length, snapshotId })));
    if (!current()) return [];
    if (
      typeof page.text !== 'string' ||
      !page.text ||
      page.text.length > 6000 ||
      typeof page.snapshotId !== 'string' ||
      !page.snapshotId ||
      (snapshotId && page.snapshotId !== snapshotId)
    )
      throw new Error('Invalid history page');
    snapshotId = page.snapshotId;
    text += page.text;
    if (text.length > 2 * 1024 * 1024) throw new Error('Transcript history exceeds transfer limit');
    if (page.nextOffset === null) return parseHistory(text, callId);
    if (page.nextOffset !== text.length) throw new Error('Invalid history offset');
  }
}
