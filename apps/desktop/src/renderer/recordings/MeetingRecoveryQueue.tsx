import { useEffect, useRef, useState, type JSX } from 'react';
import type { RecordingRecoveries } from '@fss/contracts';
import { transcriptPorts, type TranscriptPorts } from '../meetings/MeetingTranscript.tsx';
import { navigate } from '../routes.ts';
import { RecordingRecoveryAction } from './RecordingRecoveryAction.tsx';
const readRecoveries = async () => await globalThis.callieApi?.read('recordings.recoveries', {}) ?? { items: null, truncated: false };
export function MeetingRecoveryQueue({ read = readRecoveries, ports = transcriptPorts }: { read?: () => Promise<{ items: RecordingRecoveries['items'] | null; truncated: boolean }>; ports?: TranscriptPorts }): JSX.Element | null {
  const generation = useRef(0);
  const [value, setValue] = useState<RecordingRecoveries | null>(null);
  useEffect(() => {
    let current = true;
    const refresh = () => { const mine = ++generation.current; void read().then(answer => { if (current && mine === generation.current) setValue(answer.items === null ? null : { ...answer, items: answer.items }); }, () => { if (current && mine === generation.current) setValue(null); }); };
    refresh(); const timer = setInterval(refresh, 60000);
    return () => { current = false; clearInterval(timer); };
  }, [read]);
  if (value === null || value.items.length === 0) return null;
  const rows = [...new Map(value.items.map(row => [row.recordingId, row])).values()];
  return <section className="mb-3" data-testid="meeting-recovery-queue">
    <h3 className="px-2 py-1 text-xs font-medium text-muted-foreground">Recordings needing audio</h3>
    {rows.map(row => <div key={row.recordingId} className="flex flex-col gap-1 px-2 py-2" data-testid="meeting-recovery-item">
      <a className="text-sm hover:underline" href={`#firm/${row.firmId}`} onClick={event => { event.preventDefault(); navigate({ name: 'firm', firmId: row.firmId }); }}>{row.firmName}</a>
      <p className="break-words text-xs text-muted-foreground">{row.participantLabel}</p>
      <RecordingRecoveryAction recordingId={row.recordingId} ports={ports} onRecovered={() => { generation.current++; setValue(current => current === null ? null : { ...current, items: current.items.filter(item => item.recordingId !== row.recordingId) }); }} />
    </div>)}
    {value.truncated ? <p className="px-2 text-xs text-muted-foreground">More recordings need audio. Resolve these to see the next ones.</p> : null}
  </section>;
}
