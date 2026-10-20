import { useEffect, useReducer } from 'react';
import type { MeetingFollowThroughViewV2, SaveMeetingUnpublishedPlan } from '@fss/contracts';
import { useSessionEpoch } from '../app/drafts.tsx';

type Entry = { form: SaveMeetingUnpublishedPlan; pending: (SaveMeetingUnpublishedPlan & { commandId: string }) | null; busy: boolean; dirty: boolean; message: string | null };
let memory: { epoch: object | null; entries: Map<string, Entry> } = { epoch: null, entries: new Map() };
const listeners = new Set<() => void>();
export function unpublishedForm(view: MeetingFollowThroughViewV2): SaveMeetingUnpublishedPlan {
  const plan = view.unpublishedPlan;
  return { meetingId: view.meetingId, expectedSourceHash: view.draftSource?.sourceHash ?? view.sourceHash, expectedNotesRevision: view.draftSource?.notesRevision ?? view.notesRevision,
    expectedPlanVersion: view.version, expectedUnpublishedRevision: plan?.revision ?? 0,
    messages: plan === null || plan === undefined ? [{subject:'',body:''},{subject:'',body:''},{subject:'',body:''},{subject:'',body:''}]
      : plan.messages.map(({subject,body}) => ({subject,body})) as SaveMeetingUnpublishedPlan['messages'] };
}
export function useUnpublishedPlanMemory(view: MeetingFollowThroughViewV2) {
  const epoch = useSessionEpoch(), [, bump] = useReducer((n: number) => n + 1, 0);
  if (memory.epoch !== epoch) memory = { epoch, entries: new Map() };
  let entry = memory.entries.get(view.meetingId);
  if (entry === undefined) {
    const form = unpublishedForm(view);
    if (view.unpublishedPlan != null) { form.expectedSourceHash = view.unpublishedPlan.sourceHash; form.expectedNotesRevision = view.unpublishedPlan.notesRevision; }
    entry = {form,pending:null,busy:false,dirty:false,message:null}; memory.entries.set(view.meetingId,entry);
  }
  const current = unpublishedForm(view);
  const stale = entry.form.expectedPlanVersion !== current.expectedPlanVersion || entry.form.expectedSourceHash !== current.expectedSourceHash || entry.form.expectedNotesRevision !== current.expectedNotesRevision || entry.form.expectedUnpublishedRevision !== current.expectedUnpublishedRevision;
  useEffect(() => { const notify = () => bump(); listeners.add(notify); return () => {listeners.delete(notify);}; }, []);
  return { entry, stale, rebase: () => { entry.form = {...current, messages: entry.form.messages}; entry.message = 'Current notes binding accepted. Your typed text is kept. Review it before saving.'; }, touch: () => { for (const listener of listeners) listener(); } };
}
