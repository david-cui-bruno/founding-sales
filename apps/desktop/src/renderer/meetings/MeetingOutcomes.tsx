import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { saveMeetingNotesSchema, type MeetingNoteItem, type MeetingNotesRevision, type MeetingOutcomesView, type MeetingTranscriptPage, type SaveMeetingNotes } from '@fss/contracts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { noDefiniteAnswer } from '../today/afterCallModel.ts';
import { MeetingDebrief } from './MeetingDebrief.tsx';
import { DeadlineEditor, MeetingTaskControls, type TaskChanger } from './MeetingTaskControls.tsx';
import { notesDraft, outcomeEntry, useOutcomesMemory } from './outcomesMemory.ts';
export interface OutcomesPorts {
  read(meetingId: string): Promise<{ view: MeetingOutcomesView | null; reason: string | null }>;
  save(input: SaveMeetingNotes & { commandId: string }): Promise<{ notes: MeetingNotesRevision | null; reason: string | null }>;
  changeTask: TaskChanger;
  transcript?(input: { meetingId: string; cursor?: string }): Promise<{ page: MeetingTranscriptPage | null; reason: string | null }>;
}
export const outcomesPorts: OutcomesPorts = {
  read: async meetingId => await globalThis.callieApi?.read('meetings.outcomes', { meetingId }) ?? { view: null, reason: 'unavailable' },
  save: async input => await globalThis.callieApi?.command('meetings.saveNotes', input) ?? { notes: null, reason: 'offline' },
  changeTask: async input => await globalThis.callieApi?.command('meetings.changeTask', input) ?? { task: null, reason: 'offline' },
  transcript: async input => await globalThis.callieApi?.read('meetings.transcript', input) ?? { page: null, reason: 'unavailable' },
};
const LOST = 'The answer was lost. Retry uses the same request.';
const humanReason = (reason: string) => ({ owner_unknown: 'Confirm who promised this', deadline_unclear: 'Confirm the deadline', commitment_uncertain: 'Check whether this was a promise', possible_duplicate: 'May repeat an existing task', notes_incomplete: 'Notes are incomplete', inferred: 'Inferred, not directly stated', cross_source_timing: 'Separate recordings have independent timing', instruction_in_source: 'Source needs review' })[reason] ?? 'Needs review';
function NoteItem({ item, draft, onChange, enabled }: { item: MeetingNoteItem; draft: SaveMeetingNotes; onChange(value: SaveMeetingNotes): void; enabled: boolean }): JSX.Element {
  const [evidence, setEvidence] = useState(false), [editing, setEditing] = useState(false);
  const override = draft.itemOverrides.find(o => o.itemId === item.id);
  const change = (patch: Partial<SaveMeetingNotes['itemOverrides'][number]>) => {
    const next = { itemId: item.id, decision: 'confirmed' as const, text: item.text, owner: item.owner, deadline: item.deadline, ...override, ...patch };
    onChange({ ...draft, itemOverrides: [...draft.itemOverrides.filter(o => o.itemId !== item.id), next] });
  };
  return <li className="space-y-1 border-b border-border py-3 last:border-0"><div className="flex flex-wrap items-baseline gap-2"><span className="min-w-0 flex-1 text-sm">{override?.text ?? item.text}</span><span className="text-xs text-muted-foreground">{override?.decision === 'dismissed' ? 'Dismissed' : (override?.owner ?? item.owner) === 'you' ? 'You' : (override?.owner ?? item.owner) === 'prospect' ? 'Prospect' : 'Owner unconfirmed'}</span><Button variant="quiet" size="sm" aria-expanded={evidence} onClick={() => { setEvidence(!evidence); }}>Evidence</Button><Button variant="quiet" size="sm" disabled={!enabled} aria-expanded={editing} onClick={() => { setEditing(!editing); }}>Correct</Button></div>
    {item.reviewReasons.length > 0 && override === undefined ? <p className="text-xs text-muted-foreground">{[...new Set(item.reviewReasons.map(humanReason))].join(' · ')}</p> : null}
    {evidence ? <div className="space-y-2 rounded-md bg-muted/40 p-3">{item.evidence.map((e,i) => <blockquote key={i} className="border-l-2 border-border pl-3 text-sm"><p className="whitespace-pre-wrap break-words">{e.quote}</p><footer className="mt-1 text-xs text-muted-foreground">{e.kind === 'debrief' ? `Your notes · revision ${e.revision}` : `Transcript · ${Math.floor(e.startMs / 60000)}:${String(Math.floor(e.startMs / 1000) % 60).padStart(2, '0')} · recording ${e.recordingId.slice(-6)}`}</footer></blockquote>)}</div> : null}
    {editing ? <div className="space-y-2 rounded-md border border-border p-3"><Input aria-label="Corrected note" maxLength={2000} value={override?.text ?? item.text} onChange={e => { change({ text: e.target.value }); }} /><select aria-label="Promise owner" className="rounded-md border border-input bg-background p-2 text-sm" value={override?.owner ?? item.owner} onChange={e => { change({ owner: e.target.value as MeetingNoteItem['owner'] }); }}><option value="unknown">Unconfirmed</option><option value="you">You</option><option value="prospect">Prospect</option></select><DeadlineEditor value={override === undefined ? item.deadline : override.deadline} onChange={value => { change({ deadline: value }); }} /><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => { change({ decision: 'confirmed' }); setEditing(false); }}>Confirm correction</Button><Button size="sm" variant="quiet" onClick={() => { change({ decision: 'dismissed' }); setEditing(false); }}>Dismiss note</Button><span className="self-center text-xs text-muted-foreground">Save notes to apply.</span></div></div> : null}
  </li>;
}
function Speakers({ draft, ports, onChange }: { draft: SaveMeetingNotes; ports: OutcomesPorts; onChange(value: SaveMeetingNotes): void }): JSX.Element {
  const [sources, setSources] = useState<SaveMeetingNotes['speakerMappings']>([]), [state, setState] = useState('Reading speakers…');
  const portRef = useRef(ports); portRef.current = ports;
  useEffect(() => {
    let alive = true;
    void (async () => {
      const found = new Map<string, SaveMeetingNotes['speakerMappings'][number]>(); let cursor: string | undefined, revision: number | undefined;
      const cursors = new Set<string>();
      do {
        const answer = await portRef.current.transcript?.({ meetingId: draft.meetingId, ...(cursor === undefined ? {} : { cursor }) });
        const page = answer?.page;
        if (page === undefined || page === null || page.meetingId !== draft.meetingId || (revision !== undefined && page.coverage.sourceRevision !== revision)) throw new Error('unavailable');
        revision = page.coverage.sourceRevision;
        for (const u of page.utterances) {
          const label = page.recordings.find(r => r.recordingId === u.recordingId)?.participantLabel ?? 'Recording';
          found.set(`${u.recordingId}:${u.speaker ?? ''}`, { recordingId: u.recordingId, speaker: u.speaker, label: `${label}${u.speaker === null ? '' : ` · ${u.speaker}`}`.slice(0, 200), owner: 'unknown', zone: null });
        }
        cursor = page.nextCursor ?? undefined;
        if (cursor !== undefined && cursors.has(cursor)) throw new Error('cursor');
        if (cursor !== undefined) cursors.add(cursor);
        if (cursors.size > 1000 || found.size > 200) throw new Error('too_large');
      } while (alive && cursor !== undefined);
      if (alive) { setSources([...found.values()]); setState(found.size === 0 ? 'No transcript speakers yet.' : 'Confirm each source before Callie assigns promises.'); }
    })().catch(() => { if (alive) setState('Speakers could not load. Reopen this section to retry.'); });
    return () => { alive = false; };
  }, [draft.meetingId]);
  return <div className="space-y-2 rounded-md border border-border p-3"><p className="text-xs text-muted-foreground">{state}</p>{sources.map((source,i) => {
    const key = (m: typeof source) => `${m.recordingId}:${m.speaker ?? ''}`;
    const selected = draft.speakerMappings.find(m => key(m) === key(source)) ?? source;
    const set = (patch: Partial<typeof source>) => { onChange({ ...draft, speakerMappings: [...draft.speakerMappings.filter(m => key(m) !== key(source)), { ...selected, ...patch }] }); };
    return <div key={key(source)} className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1 break-words text-xs">Source {i+1} · {source.label}</span><select aria-label={`Owner of source ${i+1}`} className="rounded border border-input bg-background p-1 text-sm" value={selected.owner} onChange={e => { set({ owner: e.target.value as typeof selected.owner }); }}><option value="unknown">Unconfirmed</option><option value="you">You</option><option value="prospect">Prospect</option></select><select aria-label={`Time zone of source ${i+1}`} className="rounded border border-input bg-background p-1 text-xs" value={selected.zone ?? ''} onChange={e => { set({ zone: e.target.value || null }); }}><option value="">Time zone unconfirmed</option>{[...new Set([selected.zone ?? '', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'UTC'])].filter(Boolean).map(z => <option key={z}>{z}</option>)}</select></div>;
  })}</div>;
}
export function MeetingOutcomes({ meetingId, ports = outcomesPorts, actionsEnabled = true }: { meetingId: string; ports?: OutcomesPorts; actionsEnabled?: boolean }): JSX.Element {
  const { memory, touch } = useOutcomesMemory(), entry = outcomeEntry(memory, meetingId), portsRef = useRef(ports); portsRef.current = ports;
  const [speakers, setSpeakers] = useState(false);
  const load = useCallback(async () => {
    const generation = ++entry.generation; entry.loading = true; touch();
    try {
      const answer = await portsRef.current.read(meetingId); if (generation !== entry.generation) return;
      if (answer.view?.meetingId === meetingId) { entry.view = answer.view; entry.draft ??= notesDraft(answer.view); entry.unavailable = false; entry.gone = false; }
      else { entry.unavailable = true; if (answer.reason === 'not_found') { entry.view = null; entry.draft = null; entry.pending = null; entry.gone = true; } }
    } catch { if (generation === entry.generation) entry.unavailable = true; }
    finally { if (generation === entry.generation) { entry.loading = false; touch(); } }
  }, [entry, meetingId, touch]);
  useEffect(() => { if (entry.open) void load(); }, [entry.open, load]);
  const save = async () => {
    if (entry.busy || !actionsEnabled || entry.draft === null) return;
    if (entry.pending === null) {
      const parsed = saveMeetingNotesSchema.safeParse(entry.draft);
      if (!parsed.success) { entry.message = 'Check the notes and corrections. Notes can be up to 32 KiB and each correction needs text.'; touch(); return; }
      entry.pending = { ...parsed.data, commandId: crypto.randomUUID() };
    }
    const pending = entry.pending, { commandId: _id, ...sent } = pending;
    entry.busy = true; entry.message = null; ++entry.generation; touch();
    try {
      const answer = await portsRef.current.save(pending);
      if (answer.notes?.meetingId === meetingId) {
        const latest = entry.draft;
        if (entry.view !== null) entry.view = { ...entry.view, notes: answer.notes, state: 'stale' };
        entry.draft = JSON.stringify(latest) === JSON.stringify(sent) ? { meetingId, expectedRevision: answer.notes.revision, debrief: answer.notes.debrief, speakerMappings: answer.notes.speakerMappings, itemOverrides: answer.notes.itemOverrides, sufficient: answer.notes.sufficient } : { ...latest, expectedRevision: answer.notes.revision };
        entry.pending = null; entry.message = 'Saved.';
      } else if (noDefiniteAnswer(answer.reason)) entry.message = LOST;
      else { entry.pending = null; entry.message = answer.reason === 'notes_changed' ? 'Notes changed elsewhere. Your draft is kept. Refresh to compare, or use the latest saved notes.' : 'Notes could not be saved. Your draft is kept.'; }
    } catch { entry.message = LOST; }
    finally { entry.busy = false; entry.loading = false; touch(); }
  };
  const draft = entry.draft, view = entry.view;
  return <div id={`meeting-outcomes-${meetingId}`} className="min-w-0" data-testid="meeting-outcomes"><Button size="sm" variant="quiet" aria-expanded={entry.open} onClick={() => { entry.open = !entry.open; touch(); }}>Notes & tasks</Button>
    {entry.open ? <section className="mt-2 space-y-5 rounded-lg border border-border bg-background p-4" aria-label="Meeting notes and tasks">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-muted-foreground">{view?.state === 'stale' ? 'Sources changed. Existing tasks and your corrections are kept.' : view?.state === 'partial' ? 'Partial notes · review before relying on them.' : view?.state === 'pending' ? 'Analysis is queued.' : 'Meeting notes'}</span><Button size="sm" variant="quiet" disabled={entry.loading || entry.busy} onClick={() => { void load(); }}>Refresh notes</Button></div>
      {entry.unavailable ? <p role="status" className="text-sm text-muted-foreground">{entry.gone ? 'These notes are no longer available.' : 'Callie could not load the latest notes. Try Refresh notes.'}</p> : null}
      {view === null || draft === null ? entry.loading ? <p className="text-sm text-muted-foreground">Reading notes…</p> : null : <>
        {view.holds.includes('analysis_disabled') ? <p className="text-xs text-muted-foreground">Analysis is off. You can still save your notes. Enable meeting analysis in Calling & calendar when ready.</p> : null}
        {view.holds.includes('merged_notes_review') ? <p className="text-sm text-muted-foreground">Bookings were combined. Review the merged notes and speaker mappings, then save before analysis continues.</p> : null}
        {view.overview === '' ? null : <p className="text-sm leading-relaxed">{view.overview}</p>}
        <MeetingDebrief draft={draft} busy={entry.busy} pending={entry.pending !== null && !entry.busy} enabled={actionsEnabled && !entry.gone} onChange={value => { entry.draft = value; touch(); }} onSave={() => { void save(); }} onDiscard={() => { entry.draft = notesDraft(view); entry.message = null; touch(); }} />
        {entry.message === null ? null : <p role="status" className="text-xs text-muted-foreground">{entry.message}</p>}
        {draft.expectedRevision !== view.notes.revision ? <div className="space-y-2"><p className="whitespace-pre-wrap text-xs text-muted-foreground">Latest saved notes: {view.notes.debrief || '(empty)'}</p><Button size="sm" variant="outline" disabled={entry.busy} onClick={() => { entry.draft = notesDraft(view); entry.message = null; touch(); }}>Use latest saved notes</Button></div> : null}
        {ports.transcript === undefined ? null : <div><Button size="sm" variant="quiet" aria-expanded={speakers} disabled={!actionsEnabled} onClick={() => { setSpeakers(!speakers); }}>Confirm speakers</Button>{speakers ? <Speakers draft={draft} ports={ports} onChange={value => { entry.draft = value; touch(); }} /> : null}</div>}
        {view.items.length === 0 ? <p className="text-sm text-muted-foreground">No analyzed notes yet.</p> : <ul>{view.items.map(item => <NoteItem key={item.id} item={item} draft={draft} enabled={actionsEnabled} onChange={value => { entry.draft = value; touch(); }} />)}</ul>}
        {view.tasks.some(t => t.status === 'open' && t.userEdited && t.source.kind === 'promise' && draft.itemOverrides.some(o => t.source.kind === 'promise' && o.itemId === t.source.commitmentId)) ? <p role="status" className="text-xs text-muted-foreground">Your edited task is kept. Review it below and edit or cancel it if this correction changes the promise.</p> : null}
        <div className="space-y-3"><h4 className="text-sm font-medium">Tasks</h4>{view.tasks.length === 0 ? <p className="text-sm text-muted-foreground">No agreed tasks yet.</p> : view.tasks.map(task => <MeetingTaskControls key={task.id} task={task} change={ports.changeTask} enabled={actionsEnabled} onChanged={changed => { ++entry.generation; entry.view = { ...entry.view!, tasks: entry.view!.tasks.map(t => t.id === changed.id ? changed : t) }; touch(); }} />)}</div>
      </>}
    </section> : null}
  </div>;
}
