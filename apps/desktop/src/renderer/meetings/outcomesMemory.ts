import type {QualificationMemory} from './Qualification.tsx';
import { useCallback, useEffect, useReducer } from 'react';
import type { MeetingOutcomesView, SaveMeetingNotes, ChangeMeetingTask } from '@fss/contracts';
import { useSessionEpoch } from '../app/drafts.tsx';
export interface OutcomeEntry {
  open: boolean; view: MeetingOutcomesView | null; draft: SaveMeetingNotes | null; generation: number;
  loading: boolean; unavailable: boolean; gone: boolean; busy: boolean; message: string | null;
  pending: (SaveMeetingNotes & { commandId: string }) | null;
}
export interface TaskMemory { command: (ChangeMeetingTask & { commandId: string }) | null; busy: boolean; message: string | null; editing: boolean; draft: Extract<ChangeMeetingTask, { action: 'edit' }> | null; }
interface Memory { qualifications: Map<string,QualificationMemory>; entries: Map<string, OutcomeEntry>; tasks: Map<string, TaskMemory>; }
const fresh = (): Memory => ({ qualifications:new Map(), entries: new Map(), tasks: new Map() });
let current: { epoch: object | null; memory: Memory } = { epoch: null, memory: fresh() };
const listeners = new Set<() => void>();
export function useOutcomesMemory() {
  const epoch = useSessionEpoch(), [, bump] = useReducer((n: number) => n + 1, 0);
  if (current.epoch !== epoch) current = { epoch, memory: fresh() };
  useEffect(() => { const listener = () => { bump(); }; listeners.add(listener); return () => { listeners.delete(listener); }; }, []);
  const touch = useCallback(() => { for (const listener of listeners) listener(); }, []);
  return { memory: current.memory, touch };
}
export function outcomeEntry(memory: Memory, id: string): OutcomeEntry {
  let entry = memory.entries.get(id);
  if (entry === undefined) { entry = { open: false, view: null, draft: null, generation: 0, loading: false, unavailable: false, gone: false, busy: false, message: null, pending: null }; memory.entries.set(id, entry); }
  return entry;
}
export function notesDraft(view: MeetingOutcomesView): SaveMeetingNotes {
  const { revision, savedAt: _at, ...notes } = view.notes;
  return { ...notes, expectedRevision: revision };
}
