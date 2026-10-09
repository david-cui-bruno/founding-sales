import {ProcessingRecordHealth,type ProcessingRecordPorts} from '../firms/ProcessingRecordHealth.tsx';
import {ProcessingHealth,type ProcessingPorts} from '../firms/ProcessingHealth.tsx';
import {processingPorts} from '../firms/peoplePorts.ts';
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { MeetingTranscriptPage, RecordingProcessingView } from '@fss/contracts';
import { useSessionEpoch } from '../app/drafts.tsx';
import { Button } from '../ui/button.tsx';
import { RecordingRecoveryAction, type RecoveryPorts } from '../recordings/RecordingRecoveryAction.tsx';
export interface TranscriptPorts extends RecoveryPorts {
  read(input: { meetingId: string; cursor?: string }): Promise<{ page: MeetingTranscriptPage | null; reason: string | null }>;
}
export const transcriptPorts: TranscriptPorts = {
  read: async input => await globalThis.callieApi?.read('meetings.transcript', {...input,includeProcessing:true}) ?? { page: null, reason: 'unavailable' },
  reupload: async recordingId => await globalThis.callieApi?.command('recordings.reupload', { recordingId }) ?? { status: 'unavailable' },
  chooseFile: async recordingId => await globalThis.callieImport?.chooseRecordingRecoveryFile(recordingId) ?? { status: 'unavailable' },
};
function sourceStatus(source: RecordingProcessingView): string {
  if (source.status === 'needs_reupload') return 'Original audio is needed to finish this transcript.';
  if (source.status === 'funding_unverified') return 'Waiting for verified AWS credit coverage.';
  if (source.status === 'budget_held') return 'Waiting for the daily meeting allowance.';
  if (source.reason === 'zero_allowance') return 'Set a daily meeting allowance in Settings.';
  if (source.reason === 'not_eligible') return 'This meeting must be linked to an active firm.';
  if (source.status === 'disabled') return 'Meeting transcription is off.';
  if (source.status === 'failed') return source.reason === 'attempt_limit' ? 'Processing limit reached. This recording needs a review.' : 'The transcript could not be completed.';
  return 'Transcript is being prepared.';
}
const timestamp = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
interface View { epoch: object | null; meetingId: string; page: MeetingTranscriptPage | null; reason: string | null }
export function MeetingTranscript({ meetingId, ports = transcriptPorts, actionsEnabled = true,processing=processingPorts,recordHealth }: { meetingId: string; ports?: TranscriptPorts; actionsEnabled?: boolean;processing?:ProcessingPorts;recordHealth?:ProcessingRecordPorts }): JSX.Element {
  const epoch = useSessionEpoch();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [view, setView] = useState<View | null>(null);
  const request = useRef(0), alive = useRef(true);
  const invalidate = useCallback(() => { request.current++; }, []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; invalidate(); }; }, [meetingId, epoch, invalidate]);
  const page = view?.epoch === epoch && view.meetingId === meetingId ? view.page : null;
  const reason = view?.epoch === epoch && view.meetingId === meetingId ? view.reason : null;
  const load = useCallback(async (cursor?: string) => {
    const mine = ++request.current; setBusy(true);
    try {
      let answer = await ports.read({ meetingId, ...(cursor === undefined ? {} : { cursor }) });
      let append = cursor !== undefined;
      if (answer.reason === 'transcript_changed' && append) { answer = await ports.read({ meetingId }); append = false; }
      if (!alive.current || mine !== request.current) return;
      if (answer.page !== null && answer.page.meetingId !== meetingId) return;
      setView(previous => {
        const next = answer.page;
        const old = previous?.epoch === epoch && previous.meetingId === meetingId ? previous.page : null;
        if (append && next !== null && old !== null && old.coverage.sourceRevision === next.coverage.sourceRevision) {
          return { epoch, meetingId, reason: null, page: { ...next, utterances: [...new Map([...old.utterances, ...next.utterances].map(row => [row.id, row])).values()] } };
        }
        return { epoch, meetingId, page: next, reason: answer.reason };
      });
    } catch { if (alive.current && mine === request.current) setView({ epoch, meetingId, page: null, reason: 'unavailable' }); }
    finally { if (alive.current && mine === request.current) setBusy(false); }
  }, [ports, meetingId, epoch]);
  const toggle = () => { if (open) { setOpen(false); request.current++; setBusy(false); } else { setOpen(true); void load(); } };
  const sourceIds = page === null ? [] : [...new Set([...page.recordings.map(row => row.recordingId), ...page.utterances.map(row => row.recordingId)])];
  return <div className="min-w-0" data-testid="meeting-transcript">
    <ProcessingRecordHealth key={`processing:${meetingId}`} kind="meeting" recordId={meetingId} {...(recordHealth===undefined?{}:{ports:recordHealth})}/>
    <div className="flex items-center gap-2">
      <Button size="sm" variant="quiet" aria-expanded={open} onClick={toggle}>Transcript</Button>
      {open && page !== null ? <span className="text-xs text-muted-foreground">{page.coverage.ready} of {page.coverage.total} recordings ready</span> : null}
      {open ? <Button size="sm" variant="quiet" disabled={busy} onClick={() => { void load(); }}>Refresh transcript</Button> : null}
    </div>
    {open ? <div data-testid="transcript-content" className="mt-2 flex min-w-0 flex-col gap-4 rounded-md border border-border bg-background p-3">
      {page === null ? <p className="text-sm text-muted-foreground">{busy ? 'Reading the transcript…' : reason === 'not_found' ? 'This transcript is no longer available.' : 'The transcript is unavailable right now. Try Refresh transcript.'}</p> : <>
        <p className="text-xs text-muted-foreground">Times are relative to each audio file. File labels and speaker labels are provisional.</p>
        {page.coverage.total === 0 ? <p className="text-sm text-muted-foreground">No demo recordings yet.</p> : null}
        {sourceIds.map((id, index) => {
          const source = page.recordings.find(row => row.recordingId === id), speech = page.utterances.filter(row => row.recordingId === id);
          return <section key={id} data-testid="transcript-source" data-recording-id={id} className="flex min-w-0 flex-col gap-2">
            <h4 className="break-words text-sm font-medium">{source?.participantLabel ?? 'Additional recording'} <span className="font-normal text-muted-foreground">· source {index + 1}{source !== undefined && source.segment > 1 ? ` · segment ${source.segment}` : ''}</span></h4>
            {source !== undefined && source.status !== 'ready' ? <p className="text-sm text-muted-foreground">{sourceStatus(source)}</p> : null}
            {source?.status === 'needs_reupload' ? <RecordingRecoveryAction recordingId={id} ports={ports} enabled={actionsEnabled} onRecovered={() => { void load(); }} /> : null}
            {source?.status === 'ready' && speech.length === 0 ? <p className="text-sm text-muted-foreground">{page.nextCursor === null ? 'No speech detected.' : 'Speech for this source may be on the next page.'}</p> : null}
            <ol className="flex flex-col gap-2">{speech.map(line => <li key={line.id} className="flex min-w-0 gap-3 text-sm">
              <span className="w-10 shrink-0 text-xs text-muted-foreground tabular-nums">{timestamp(line.startMs)}</span>
              <p className="min-w-0 whitespace-pre-wrap break-words">{line.attribution === 'provider_label' ? <span className="text-muted-foreground">{line.speaker ?? 'Unidentified speaker'} · </span> : null}{line.text}</p>
            </li>)}</ol>
          </section>;
        })}
        {page.processingSources?.map(source=><ProcessingHealth key={`${source.sourceId}:${source.revision}:${source.contentHash}`} source={source} ports={processing}/>)}
        {page.processingSourcesTruncated?<p className="text-xs text-muted-foreground">Some processing sources are outside this page.</p>:null}
        {page.recordingsTruncated ? <p className="text-xs text-muted-foreground">Some source labels are omitted from this large meeting.</p> : null}
        {page.nextCursor === null ? null : <Button size="sm" variant="quiet" className="self-start" disabled={busy} onClick={() => { void load(page.nextCursor ?? undefined); }}>Load more</Button>}
      </>}
    </div> : null}
  </div>;
}
