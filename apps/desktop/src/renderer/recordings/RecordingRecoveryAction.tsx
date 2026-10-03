import { useEffect, useRef, useState, type JSX } from 'react';
import type { RecordingRecoveryView } from '../../shared/recordings.ts';
import { Button } from '../ui/button.tsx';
export interface RecoveryPorts {
  reupload(recordingId: string): Promise<RecordingRecoveryView>;
  chooseFile(recordingId: string): Promise<RecordingRecoveryView>;
}
const NOTES: Partial<Record<RecordingRecoveryView['status'], string>> = {
  wrong_file: 'Choose the original audio file. This file does not match.',
  unavailable: 'This recording is not available to recover right now. Refresh and try again.',
  upload_failed: 'The upload did not finish. Try again.',
};
export function RecordingRecoveryAction({ recordingId, ports, onRecovered, enabled = true }: { recordingId: string; ports: RecoveryPorts; onRecovered(): void; enabled?: boolean }): JSX.Element {
  const [busy, setBusy] = useState(false), [choose, setChoose] = useState(false), [note, setNote] = useState<string | null>(null);
  const pending = useRef(false), current = useRef(true);
  useEffect(() => { current.current = true; return () => { current.current = false; }; }, []);
  const recover = async () => {
    if (pending.current || !enabled) return;
    pending.current = true; setBusy(true); setNote(null);
    try {
      const answer = await (choose ? ports.chooseFile(recordingId) : ports.reupload(recordingId));
      if (!current.current) return;
      if (answer.status === 'resumed' || answer.status === 'already_ready') { onRecovered(); return; }
      if (answer.status === 'choose_file' || answer.status === 'wrong_file') setChoose(true);
      setNote(NOTES[answer.status] ?? null);
    } catch { if (current.current) setNote('The answer was lost. Refresh before trying again.'); }
    finally { pending.current = false; if (current.current) setBusy(false); }
  };
  return <div className="flex flex-col items-start gap-1">
    <Button size="sm" variant="quiet" disabled={busy || !enabled} onClick={() => { void recover(); }}>{busy ? 'Reuploading…' : choose ? 'Choose audio file…' : 'Reupload audio'}</Button>
    {note === null ? null : <p role="status" className="text-xs text-muted-foreground">{note}</p>}
  </div>;
}
