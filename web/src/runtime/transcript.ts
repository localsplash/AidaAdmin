export interface Segment {
  key: string;
  sequence: number;
  text: string;
  isFinal: boolean;
  speaker: 'caller' | 'assistant';
}
export function receiveTranscript(rows: Segment[], bytes: Uint8Array, callId: string): Segment[] {
  if (bytes.byteLength > 16000) return rows;
  try {
    const p = JSON.parse(new TextDecoder().decode(bytes));
    if (
      p.type !== 'transcript' ||
      p.callId !== callId ||
      !['caller', 'assistant'].includes(p.speaker) ||
      typeof p.isFinal !== 'boolean' ||
      typeof p.text !== 'string' ||
      p.text.length > 6000 ||
      !Number.isSafeInteger(p.sequence) ||
      p.sequence < 1 ||
      typeof p.streamId !== 'string' ||
      p.streamId.length > 128 ||
      typeof p.segmentId !== 'string' ||
      p.segmentId.length > 256
    )
      return rows;
    const key = `${p.streamId}:${p.speaker}:${p.segmentId}`;
    const old = rows.find((r) => r.key === key);
    if (old && (old.sequence >= p.sequence || old.isFinal)) return rows;
    const row: Segment = {
      key,
      sequence: p.sequence,
      text: p.text,
      isFinal: p.isFinal,
      speaker: p.speaker,
    };
    return (old ? rows.map((r) => (r.key === key ? row : r)) : [...rows, row]).slice(-200);
  } catch {
    return rows;
  }
}
