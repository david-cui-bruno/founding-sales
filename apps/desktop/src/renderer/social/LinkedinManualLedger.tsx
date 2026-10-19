import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { LinkedinManualEntry, LinkedinManualRecord, LinkedinManualView } from '@fss/contracts';
import type { OperationInput, OperationOutput } from '../../shared/operations.ts';
import { operations } from '../app/bridges.ts';
import { useSessionEpoch } from '../app/drafts.tsx';
import { Button } from '../ui/button.tsx';

export interface LinkedinManualPorts {
  read(input: OperationInput<'linkedinManual.read'>): Promise<OperationOutput<'linkedinManual.read'>>;
  bind(input: OperationInput<'linkedinManual.bind'>): Promise<OperationOutput<'linkedinManual.bind'>>;
  record(input: OperationInput<'linkedinManual.record'>): Promise<OperationOutput<'linkedinManual.record'>>;
}
const defaults: LinkedinManualPorts = {
  read: async input => { const api = operations(); if (!api) return { view: null, reason: 'unavailable' }; return api.read('linkedinManual.read', input); },
  bind: async input => { const api = operations(); if (!api) return { accepted: false, view: null, reason: 'unavailable' }; return api.command('linkedinManual.bind', input); },
  record: async input => { const api = operations(); if (!api) return { accepted: false, view: null, reason: 'unavailable' }; return api.command('linkedinManual.record', input); },
};
const localTime = (instant: string) => {
  const date = new Date(instant);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
type Pending = { kind: 'bind'; input: OperationInput<'linkedinManual.bind'> } | { kind: 'record'; input: OperationInput<'linkedinManual.record'> };
type Editor = { entryId: string; expectedRevision: number; kind: LinkedinManualRecord['kind']; connectionState: NonNullable<LinkedinManualRecord['connectionState']>; date: string; originalInstant: string | null; voided: boolean; correction: NonNullable<LinkedinManualRecord['correction']> };
const newEditor = (): Editor => ({ entryId: crypto.randomUUID(), expectedRevision: 0, kind: 'invite', connectionState: 'unknown', date: localTime(new Date().toISOString()), originalInstant: null, voided: false, correction: 'date' });
interface Memory { view: LinkedinManualView | null; selected: string; account: string; choice: string; editor: Editor; busy: boolean; pending: Pending | null; notice: string | null }
const fresh = (): Memory => ({ view: null, selected: '', account: '', choice: '', editor: newEditor(), busy: false, pending: null, notice: null });
const memories = new WeakMap<object, Memory>();

/** Recording-only UI. It never opens LinkedIn, sends, acquires inboxes or enables a channel. */
export function LinkedinManualLedger({ ports = defaults }: { ports?: LinkedinManualPorts }) {
  const epoch = useSessionEpoch();
  const [fallback] = useState(fresh);
  let found = epoch ? memories.get(epoch) : fallback;
  if (!found) { found = fresh(); memories.set(epoch!, found); }
  const m = found;
  const [, render] = useReducer(n => n + 1, 0);
  const port = useRef(ports); port.current = ports;
  const live = useRef(0);
  const load = useCallback(async (input: OperationInput<'linkedinManual.read'> = {}) => {
    const generation = live.current;
    m.busy = true; render();
    try {
      let answer = await port.current.read(input);
      if (generation !== live.current) return;
      const first = answer.view?.ledgers[0];
      if (!input.ledgerId && first) {
        m.selected = first.id;
        answer = await port.current.read({ ledgerId: first.id });
        if (generation !== live.current) return;
      }
      m.view = answer.view;
      m.notice = answer.view ? null : 'Manual ledger unavailable. Do not infer connection or reply coverage.';
    } catch { if (generation === live.current) { m.view = null; m.notice = 'Manual ledger unavailable. Refresh before relying on its state.'; } }
    finally { if (generation === live.current) { m.busy = false; render(); } }
  }, [m]);
  useEffect(() => {
    const lifetime = live;
    lifetime.current++; m.busy = false;
    void load(m.selected ? { ledgerId: m.selected } : {});
    return () => { lifetime.current++; };
  }, [load, m]);
  const run = async (pending: Pending) => {
    if (m.busy) return;
    const generation = live.current;
    m.busy = true; m.pending = pending; m.notice = null; render();
    try {
      const answer = pending.kind === 'bind' ? await port.current.bind(pending.input) : await port.current.record(pending.input);
      if (generation !== live.current) return;
      if (answer.accepted) {
        m.pending = null; m.editor = newEditor(); m.view = answer.view;
        m.selected = answer.view?.ledgers.find(row => row.id === pending.input.ledgerId)?.id ?? answer.view?.ledgers[0]?.id ?? '';
        m.notice = answer.view ? 'Manual owner record saved.' : 'Record saved. Refresh manual ledger before relying on its state.';
      } else {
        if (!['offline', 'unavailable', 'unreadable_answer'].includes(answer.reason ?? '')) m.pending = null;
        m.notice = m.pending ? 'Could not confirm this was saved. Do not follow up. Retry this same record or check history.' : 'Record refused. Refresh current history and identity before correcting or retrying.';
      }
    } catch { if (generation === live.current) m.notice = 'Could not confirm this was saved. Do not follow up. Retry this same record or check history.'; }
    finally { if (generation === live.current) { m.busy = false; render(); } }
  };
  const bind = () => {
    const choice = m.view?.choices[Number(m.choice)];
    if (!choice || !m.account || m.choice === '') return;
    const { personName: _person, firmName: _firm, profile: _profile, ...identity } = choice;
    void run({ kind: 'bind', input: { ...identity, ledgerId: crypto.randomUUID(), accountId: m.account, commandId: crypto.randomUUID() } });
  };
  const record = () => {
    const e = m.editor;
    const date = new Date(e.date);
    if (!m.selected || !Number.isFinite(date.getTime())) { m.notice = 'Choose a valid activity date and time.'; render(); return; }
    void run({ kind: 'record', input: {
      ledgerId: m.selected, entryId: e.entryId, expectedRevision: e.expectedRevision, commandId: crypto.randomUUID(),
      kind: e.kind, connectionState: e.kind === 'connection' ? e.connectionState : null,
      occurredAt: e.originalInstant && e.date === localTime(e.originalInstant) ? e.originalInstant : date.toISOString(), voided: e.voided, correction: e.expectedRevision > 0 ? e.voided ? 'void' : e.correction : null,
    } });
  };
  const correct = (entry: LinkedinManualEntry) => {
    m.editor = { entryId: entry.entryId, expectedRevision: entry.revision, kind: entry.kind, connectionState: entry.connectionState ?? 'unknown', date: localTime(entry.occurredAt), originalInstant: entry.occurredAt, voided: entry.voided, correction: 'date' }; render();
  };
  const selected = m.view?.ledgers.find(row => row.id === m.selected);
  const locked = m.busy || m.pending !== null;
  const set = (change: () => void) => { change(); render(); };
  return <section aria-label="Manual LinkedIn selling ledger" className="space-y-3 rounded-md border p-3">
    <h2>Manual LinkedIn ledger</h2>
    <p>You recorded this activity yourself. Callie has not verified it on LinkedIn or checked all replies. Check replies before contacting anyone. Callie does not send or enable LinkedIn actions here.</p>
    <p>Choose an existing CRM Person, Firm relationship and supported profile. Missing identity evidence stays unknown. Lists show up to 100 associations/choices and history is paginated.</p>
    {m.notice && <p role="status">{m.notice}</p>}
    <Button disabled={m.busy} variant="outline" onClick={() => void load(m.selected ? { ledgerId: m.selected } : {})}>Refresh manual ledger</Button>
    {m.pending && <Button disabled={m.busy} variant="outline" onClick={() => void run(m.pending!)}>Retry saving this record</Button>}
    {m.view && <>
      <fieldset disabled={locked} className="space-y-2"><legend>Account and CRM association</legend>
        <label>LinkedIn ledger account<select aria-label="LinkedIn ledger account" value={m.account} onChange={e => set(() => { m.account = e.target.value; })}><option value="">Choose account</option>{m.view.accounts.map(a => <option key={a.id} value={a.id}>{a.displayName}</option>)}</select></label>
        <label>Person, Firm and profile<select aria-label="Person, Firm and profile" value={m.choice} onChange={e => set(() => { m.choice = e.target.value; })}><option value="">Choose CRM relationship</option>{m.view.choices.map((c, i) => <option key={`${c.claimId}:${c.relationshipId}`} value={i}>{c.personName} at {c.firmName}: {c.profile}</option>)}</select></label>
        <Button disabled={!m.account || m.choice === ''} onClick={bind}>Add manual ledger</Button>
      </fieldset>
      <label>Existing manual ledger<select aria-label="Existing manual ledger" disabled={locked} value={m.selected} onChange={e => { m.selected = e.target.value; m.editor = newEditor(); render(); void load({ ledgerId: m.selected }); }}><option value="">Choose ledger</option>{m.view.ledgers.map(row => <option key={row.id} value={row.id}>{row.personName ?? 'Identity needs review'} at {row.firmName ?? 'Firm needs review'} ({row.connectionState})</option>)}</select></label>
      {selected && <>
        <p>Connection: {selected.connectionState} (owner recorded, not native verification).</p>
        {!selected.bindingCurrent && <p>CRM/profile evidence changed or is unavailable. No current profile or authority is inferred. Historical records remain.</p>}
        {selected.handoffRequired && <div role="alert"><p>Follow-up stopped across channels. Human handoff required.</p><p>Corrections never resume follow-up or remove the original stop.</p></div>}
        <fieldset disabled={locked} className="space-y-2"><legend>{m.editor.expectedRevision ? 'Correct a retained record' : 'Record an action that already occurred'}</legend>
          <label>Activity kind<select aria-label="Activity kind" value={m.editor.kind} onChange={e => set(() => { m.editor.kind = e.target.value as Editor['kind']; })}>{['connection', 'invite', 'message', 'reply', 'refusal'].map(kind => <option key={kind} value={kind}>{kind}</option>)}</select></label>
          {m.editor.kind === 'connection' && <label>Owner-recorded connection state<select aria-label="Owner-recorded connection state" value={m.editor.connectionState} onChange={e => set(() => { m.editor.connectionState = e.target.value as Editor['connectionState']; })}>{['unknown', 'pending', 'accepted'].map(state => <option key={state} value={state}>{state}</option>)}</select></label>}
          <label>Activity date and time<input aria-label="Activity date and time" type="datetime-local" value={m.editor.date} onChange={e => set(() => { m.editor.date = e.target.value; })} /></label>
          {m.editor.expectedRevision > 0 && <>
            <label>Correction reason<select aria-label="Correction reason" value={m.editor.correction} onChange={e => set(() => { m.editor.correction = e.target.value as Editor['correction']; })}>{['date', 'kind', 'connection_state', 'void'].map(reason => <option key={reason} value={reason}>{reason}</option>)}</select></label>
            <label><input type="checkbox" checked={m.editor.voided} onChange={e => set(() => { m.editor.voided = e.target.checked; })} />Mark record incorrect, retain history</label>
            <Button variant="outline" onClick={() => set(() => { m.editor = newEditor(); })}>Cancel correction</Button>
          </>}
          <Button onClick={record}>{m.editor.expectedRevision ? 'Save correction' : 'Record manual activity'}</Button>
        </fieldset>
        <h3>Retained manual history</h3>
        <ol>{m.view.history.map(entry => <li key={entry.sequence}>{entry.kind} at {new Date(entry.occurredAt).toLocaleString()}, recorded {new Date(entry.recordedAt).toLocaleString()}, revision {entry.revision}{entry.voided ? ' (marked incorrect)' : ''}{entry.connectionState ? `: ${entry.connectionState}` : ''} <Button variant="outline" disabled={locked} onClick={() => correct(entry)}>Correct record {entry.sequence}</Button></li>)}</ol>
        {m.view.nextBefore && <Button variant="outline" disabled={m.busy} onClick={() => void load({ ledgerId: m.selected, before: m.view!.nextBefore! })}>Older manual history</Button>}
      </>}
    </>}
  </section>;
}
