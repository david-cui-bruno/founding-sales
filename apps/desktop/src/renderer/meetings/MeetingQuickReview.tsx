import type { JSX } from 'react';
import type { MeetingNoteItem, MeetingOutcomesView, SaveMeetingNotes } from '@fss/contracts';
import { Button } from '../ui/button.tsx';

const questions: readonly { kind: MeetingNoteItem['kind']; label: string; question: string }[] = [
  { kind: 'workflow', label: 'Workflow', question: 'What is their current workflow?' },
  { kind: 'need', label: 'Main problem', question: 'What problem matters most to them?' },
  { kind: 'commitment', label: 'Commitments', question: 'What did each person commit to?' },
  { kind: 'next_step', label: 'Next step', question: 'What happens next?' },
];

/** Prompts guide human notes; they never confirm attendance, qualification or promises. */
export function MeetingQuickReview({ view, draft, enabled, onChange }: {
  view: MeetingOutcomesView; draft: SaveMeetingNotes; enabled: boolean; onChange(value: SaveMeetingNotes): void;
}): JSX.Element {
  const noConversation = view.attendance === 'no_show' || view.attendance === 'cancelled';
  const missing = questions.filter(({ kind }) => !view.items.some(item => {
    if (item.kind !== kind || (view.state !== 'current' && view.state !== 'partial')) return false;
    const correction = draft.itemOverrides.find(override => override.itemId === item.id);
    return correction === undefined ? item.provenance === 'stated' && item.reviewReasons.length === 0 : correction.decision === 'confirmed';
  }));
  return <section aria-label="Quick post-call review" className="space-y-2 rounded-md bg-muted/30 p-3">
    <h4 className="text-sm font-medium">One-minute review</h4>
    <p className="text-xs text-muted-foreground">Add only what is missing to your notes below. Skip anything you do not know; partial notes are useful. Recording and analysis settings stay as configured.</p>
    {view.attendance === 'unconfirmed' ? <p className="text-xs text-muted-foreground">Attendance is unconfirmed. Use Attended or No-show on this meeting; saving notes does not mark it held.</p> : <p className="text-xs text-muted-foreground">Attendance: {view.attendance === 'attended' ? 'confirmed attended' : view.attendance === 'no_show' ? 'no-show' : 'cancelled'}.</p>}
    <p className="text-xs text-muted-foreground">Use Demo qualification to confirm deal conclusions. For promises, check the evidence and confirm the owner and deadline below.</p>
    {noConversation ? <p className="text-xs text-muted-foreground">No conversation facts are required for a no-show or cancelled meeting. You can still add notes below.</p> : missing.length === 0 ? <p className="text-xs text-muted-foreground">These facts already have current supporting notes. Review any corrections below.</p> : <ul className="space-y-1">{missing.map(({ kind, label, question }) => {
      const unknown = `${label}: unknown.`;
      const leftUnknown = draft.debrief.split('\n').includes(unknown);
      return <li key={kind} className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>{question}</span>{leftUnknown ? <span className="text-xs text-muted-foreground">Left unknown in your notes</span> : <Button size="sm" variant="quiet" disabled={!enabled} aria-label={`Leave ${label.toLowerCase()} unknown`} onClick={() => { onChange({ ...draft, sufficient: false, debrief: [draft.debrief, unknown].filter(Boolean).join('\n\n') }); }}>Unknown</Button>}</li>;
    })}</ul>}
  </section>;
}
