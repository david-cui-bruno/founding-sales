import type { JSX } from 'react';
import type { SaveMeetingNotes } from '@fss/contracts';
import { Button } from '../ui/button.tsx';
export function MeetingDebrief({ draft, busy, pending, enabled, onChange, onSave, onDiscard }: { draft: SaveMeetingNotes; busy: boolean; pending: boolean; enabled: boolean; onChange(value: SaveMeetingNotes): void; onSave(): void; onDiscard(): void }): JSX.Element {
  return <div className="space-y-2">
    <label className="block text-sm font-medium">Your notes<textarea aria-label="Your notes" className="mt-2 min-h-28 w-full resize-y rounded-md border border-input bg-background p-3 text-sm font-normal leading-relaxed outline-none focus:ring-2 focus:ring-ring" placeholder="What mattered? What did you agree to? Type here, or use Mac Dictation." value={draft.debrief} disabled={!enabled} onChange={event => { onChange({ ...draft, debrief: event.target.value }); }} /></label>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={draft.sufficient} disabled={!enabled} onChange={event => { onChange({ ...draft, sufficient: event.target.checked }); }} />These notes are enough to identify our agreed next steps</label>
      <div className="flex gap-1"><Button size="sm" variant="quiet" disabled={!enabled || busy || pending} onClick={onDiscard}>Discard edits</Button><Button size="sm" disabled={!enabled || busy} onClick={onSave}>{pending ? 'Retry save' : busy ? 'Saving…' : 'Save notes'}</Button></div>
    </div>
  </div>;
}
