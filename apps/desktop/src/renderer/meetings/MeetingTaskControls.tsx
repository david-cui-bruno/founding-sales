import { noDefiniteAnswer } from '../today/afterCallModel.ts';
import type { JSX } from 'react';
import { callbackInstant, meetingDeadlineSchema, type MeetingDeadline, type MeetingTaskView, type ChangeMeetingTask } from '@fss/contracts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { useOutcomesMemory } from './outcomesMemory.ts';
export function deadlineLabel(deadline: MeetingDeadline): string {
  return deadline.precision === 'date' ? new Date(`${deadline.localDate}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
    : new Date(deadline.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: deadline.zone });
}
export function DeadlineEditor({ value, onChange }: { value: MeetingDeadline | null; onChange(value: MeetingDeadline | null): void }): JSX.Element {
  const zone = value?.zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = value?.precision === 'instant' ? new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value.at)) : [];
  const part = (key: string) => parts.find(p => p.type === key)?.value ?? '';
  const date = value === null ? '' : value.precision === 'date' ? value.localDate : `${part('year')}-${part('month')}-${part('day')}`;
  const time = value?.precision === 'instant' ? `${part('hour')}:${part('minute')}` : '';
  const update = (nextDate: string, nextTime: string, nextZone: string) => {
    if (nextDate === '') { onChange(null); return; }
    const at = nextTime === '' ? null : callbackInstant(nextDate, nextTime, nextZone);
    const candidate = nextTime === '' ? { precision: 'date', localDate: nextDate, zone: nextZone } : { precision: 'instant', at, zone: nextZone };
    const parsed = meetingDeadlineSchema.safeParse(candidate);
    if (parsed.success) onChange(parsed.data);
  };
  return <div className="flex flex-wrap gap-2"><Input type="date" aria-label="Due date" className="w-36" value={date} onChange={e => { update(e.target.value, time, zone); }} /><Input type="time" aria-label="Due time (optional)" className="w-28" value={time} onChange={e => { update(date, e.target.value, zone); }} /><select aria-label="Deadline time zone" className="rounded-md border border-input bg-background px-2 text-xs" value={zone} onChange={e => { update(date, time, e.target.value); }}>{[...new Set([zone, 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'UTC'])].map(z => <option key={z}>{z}</option>)}</select></div>;
}
export type TaskChanger = (input: ChangeMeetingTask & { commandId: string }) => Promise<{ task: MeetingTaskView | null; reason: string | null }>;
export function MeetingTaskControls({ task, change, enabled = true, onChanged }: { task: MeetingTaskView; change: TaskChanger; enabled?: boolean; onChanged(task: MeetingTaskView): void }): JSX.Element {
  const { memory, touch } = useOutcomesMemory();
  let stored = memory.tasks.get(task.id);
  if (stored === undefined) { stored = { command: null, busy: false, message: null, editing: false, draft: null }; memory.tasks.set(task.id, stored); }
  const kept = stored;
  const send = async (input: ChangeMeetingTask | null) => {
    if (kept.busy || !enabled) return;
    if (kept.command === null && input !== null) kept.command = { ...input, commandId: crypto.randomUUID() };
    const command = kept.command; if (command === null) return;
    kept.busy = true; kept.message = null; touch();
    try {
      const answer = await change(command);
      if (answer.task?.id === task.id && answer.task.meetingId === task.meetingId) { kept.command = null; kept.editing = false; kept.draft = null; onChanged(answer.task); }
      else if (noDefiniteAnswer(answer.reason)) kept.message = 'The answer was lost. Retry uses the same request.';
      else { kept.command = null; kept.message = answer.reason === 'task_changed' ? 'This task changed elsewhere. Refresh before editing again.' : 'The task could not be changed. Refresh and try again.'; }
    } catch { kept.message = 'The answer was lost. Retry uses the same request.'; }
    finally { kept.busy = false; touch(); }
  };
  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1 text-sm">{task.label}</span><span className="text-xs text-muted-foreground">{deadlineLabel(task.deadline)}{task.status === 'open' ? '' : ` · ${task.status}`}</span>
      {task.status === 'open' ? <><Button size="sm" variant="quiet" disabled={!enabled || kept.busy || kept.command !== null} aria-label={`Complete ${task.label}`} onClick={() => { void send({ taskId: task.id, expectedVersion: task.version, action: 'complete' }); }}>Done</Button><Button size="sm" variant="quiet" aria-expanded={kept.editing} disabled={!enabled || kept.busy || kept.command !== null} onClick={() => { kept.editing = !kept.editing; kept.draft ??= { taskId: task.id, expectedVersion: task.version, action: 'edit', label: task.label, deadline: task.deadline }; touch(); }}>Edit task</Button></> : null}
    </div>
    {kept.editing && kept.draft !== null ? <div className="space-y-2 rounded-md border border-border p-3"><Input aria-label="Task description" value={kept.draft.label} onChange={e => { if (kept.draft !== null) kept.draft = { ...kept.draft, label: e.target.value }; touch(); }} /><DeadlineEditor value={kept.draft.deadline} onChange={value => { if (value !== null && kept.draft !== null) kept.draft = { ...kept.draft, deadline: value }; touch(); }} /><Button size="sm" disabled={!enabled || kept.busy || kept.draft.label.trim() === ''} onClick={() => { void send(kept.draft); }}>Save task</Button><Button size="sm" variant="quiet" disabled={!enabled || kept.busy} onClick={() => { void send({ taskId: task.id, expectedVersion: task.version, action: 'cancel' }); }}>Cancel task</Button></div> : null}
    {kept.message === null ? null : <p role="status" className="text-xs text-muted-foreground">{kept.message}</p>}{kept.command !== null && !kept.busy ? <Button size="sm" onClick={() => { void send(null); }}>Retry task</Button> : null}
  </div>;
}
