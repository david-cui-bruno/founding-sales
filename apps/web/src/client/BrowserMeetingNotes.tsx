import { useState, type JSX } from 'react';
import { z } from 'zod';
import { meetingNotesRevisionSchema, meetingOutcomesViewSchema, saveMeetingNotesSchema, uuid, type MeetingOutcomesView, type SaveMeetingNotes } from '@fss/contracts';
import { MeetingDebrief } from './MeetingDebrief.tsx';
import { BrowserBoundaryError, type BrowserClient, type PendingNotes } from './BrowserClient.ts';

const receiptSchema = z.strictObject({ status: z.literal('accepted'), replayed: z.boolean(), result: meetingNotesRevisionSchema });
const draftOf = (view: MeetingOutcomesView): SaveMeetingNotes => saveMeetingNotesSchema.parse({
  meetingId: view.meetingId, expectedRevision: view.notes.revision, debrief: view.notes.debrief,
  speakerMappings: view.notes.speakerMappings, itemOverrides: view.notes.itemOverrides, sufficient: view.notes.sufficient,
});

/** Meeting notes use the current private browser draft and exact command custody. */
export function BrowserMeetingNotes({ client, firmId }: { client: BrowserClient; firmId: string }): JSX.Element {
  const restored = client.pending();
  const [meetingId, setMeetingId] = useState(restored?.draft.meetingId ?? '');
  const [view, setView] = useState<MeetingOutcomesView | null>(null);
  const [draft, setDraft] = useState<SaveMeetingNotes | null>(null);
  const [pending, setPending] = useState<PendingNotes | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('Select an existing meeting by its ID. No calling, capture or provider action is available.');
  const read = async (): Promise<void> => {
    const epoch = client.epoch;
    setBusy(true);
    setView(null);
    setDraft(null);
    setPending(null);
    try {
      const id = uuid.parse(meetingId);
      const answer = await client.request(`/meetings/outcomes?meetingId=${encodeURIComponent(id)}`, meetingOutcomesViewSchema);
      if (!client.isCurrent(epoch)) return;
      if (answer.firmId !== firmId) throw new BrowserBoundaryError('refused');
      const held = client.pending();
      if (held !== null && held.draft.meetingId !== answer.meetingId) {
        setNotice('Another meeting has an unresolved save. Open that meeting and reconcile it first.');
        return;
      }
      setView(answer);
      setDraft(held?.draft ?? draftOf(answer));
      setPending(held);
      setNotice(held === null ? `Notes revision ${answer.notes.revision}.` : 'An unresolved save is retained. Review current notes below, then retry explicitly with the same request ID. Nothing was automatically sent.');
    } catch { if (client.isCurrent(epoch)) setNotice('Meeting notes unavailable. Check the meeting ID and access, then retry.'); }
    finally { if (client.isCurrent(epoch)) setBusy(false); }
  };
  const save = async (): Promise<void> => {
    if (draft === null || view === null || busy) return;
    const epoch = client.epoch;
    setBusy(true);
    let held: PendingNotes | null = null;
    try {
      held = client.prepareNotes(draft);
      const command = held;
      const answer = await client.request('/meetings/notes', receiptSchema,
        { ...command.draft, commandId: command.commandId },
        () => { client.retainPending(command); setPending(command); });
      if (!client.isCurrent(epoch)) return;
      if (answer.result.meetingId !== command.draft.meetingId || answer.result.revision !== command.draft.expectedRevision + 1) throw new BrowserBoundaryError('invalid_response');
      client.completePending(command.commandId);
      setPending(null);
      const next = { ...view, notes: answer.result };
      setView(next);
      setDraft(draftOf(next));
      setNotice(`Saved notes revision ${answer.result.revision}${answer.replayed ? ' (existing receipt)' : ''}.`);
    } catch (error) {
      if (!client.isCurrent(epoch)) return;
      const retained = client.pending();
      setPending(retained);
      setNotice(error instanceof BrowserBoundaryError && error.reason === 'storage_unavailable'
        ? 'Save not sent: browser session storage is unavailable.'
        : retained !== null ? 'Save outcome is unresolved. Your exact draft and request ID are retained. Read current notes or explicitly retry the same save. No automatic retry.' : 'Save was not confirmed. Refresh access before trying again.');
    } finally { if (client.isCurrent(epoch)) setBusy(false); }
  };
  return <section aria-label="Meeting notes" className="space-y-3 rounded-md border p-4">
    <h3>Meeting notes</h3>
    <label>Meeting ID<input aria-label="Meeting ID" value={meetingId} disabled={busy} onChange={event => { setMeetingId(event.target.value); }} /></label>
    <button type="button" disabled={busy} onClick={() => { void read(); }}>Read meeting notes</button>
    <p role="status">{notice}</p>
    {view !== null ? <div><p>Current saved notes, revision {view.notes.revision}</p><blockquote className="whitespace-pre-wrap">{view.notes.debrief || 'No saved notes yet.'}</blockquote>{view.overview ? <p>{view.overview}</p> : null}</div> : null}
    {draft !== null ? <><MeetingDebrief draft={draft} busy={busy} pending={pending !== null} enabled={!busy} onChange={value => { if (pending === null) setDraft(value); }} onSave={() => { void save(); }} onDiscard={() => { if (view !== null && pending === null) setDraft(draftOf(view)); }} />
      {pending !== null ? <p>Unresolved request {pending.commandId}. The retained draft is locked until its receipt is confirmed. Retry save reuses this exact request.</p> : null}</> : null}
  </section>;
}
