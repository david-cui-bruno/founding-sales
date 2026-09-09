import { useState } from 'react';
import type { LocalCommitmentsSnapshot } from '../../../shared/contracts/localWorkspaceContract';
import type { LocalRead } from './localWorkspaceRead';
export type RetainedItem = LocalCommitmentsSnapshot['items'][number];
export const retainedKey = ({ item }: RetainedItem) => JSON.stringify(['retained', item.salesCycleId, item.action.id]);
const labels: Record<RetainedItem['kind'], string> = { callback: 'Retained callback', post_stage: 'Post-stage follow-through', onboarding: 'Onboarding', inbound_response: 'Inbound response', warm_relationship: 'Existing relationship', founder_resurface: 'Founder resurface' };
export function RetainedWork({ read, selected, onSelect }: { read: LocalRead<LocalCommitmentsSnapshot>; selected: string | null; onSelect(key: string): void }) {
  return <div className="native-desk__retained">
    <h3>Existing commitments and relationships</h3>
    {read.error ? <p role="status">{read.value ? 'Retained work is stale. Refresh before opening a contact.' : 'Retained work could not be checked. Retry the local read.'}</p> : read.pending ? <p role="status">Checking retained work…</p> : null}
    {!!read.value?.reviewErrorCount && <p role="status">Some retained work could not be read. This local snapshot is incomplete.</p>}
    {!read.pending && !read.error && read.value?.items.length === 0 && <p className="native-desk__empty">No retained work due in this local snapshot.</p>}
    {read.value?.items.map(entry => <button key={retainedKey(entry)} type="button" className="native-desk__row" data-row-key={retainedKey(entry)} aria-current={selected === retainedKey(entry) ? 'true' : undefined} aria-label={`${labels[entry.kind]} · ${entry.item.personName} · ${entry.item.action.label}`} onClick={() => onSelect(retainedKey(entry))}>
      <strong>{entry.item.personName}</strong><small>{labels[entry.kind]}</small><span>{entry.item.action.label}</span>
    </button>)}
  </div>;
}
/** Pure presentation. No inspector, preparation, composer or command API mounts. */
export function RetainedWorkDetail({ entry, stale, onOpenLead }: { entry: RetainedItem; stale: boolean; onOpenLead(personId: string): void }) {
  const { item } = entry;
  return <section aria-label="Retained work detail"><h2>{item.personName}</h2><p>{labels[entry.kind]}</p><p>{item.contextLabel}</p><h3>{item.action.label}</h3><p>{item.reason}</p><p>Action type: {item.action.type} · Channel: {item.action.channel} · Lane: {item.lane}</p>
    <p>{item.action.dueAt ? <time dateTime={item.action.dueAt}>{new Date(item.action.dueAt).toLocaleString(undefined, { timeZoneName: 'short' })}</time> : 'Time not recorded'}</p>
    {item.consentRequirement && <p>{item.consentRequirement}</p>}
    <p>Stored local work. Opening the contact workspace is a separate action.</p>
    <button disabled={stale} onClick={() => onOpenLead(item.personId)}>Open contact workspace</button>
  </section>;
}
export function LocalOnlyCalls({ read, onOpenLead, initialSelected = null, onSelectionChange }: { read: LocalRead<LocalCommitmentsSnapshot>; onOpenLead(personId: string): void; initialSelected?: string | null; onSelectionChange?(key: string): void }) {
  const [selected, setSelected] = useState<string | null>(initialSelected);
  const select = (key: string) => { setSelected(key); onSelectionChange?.(key); };
  const entry = read.value?.items.find(item => retainedKey(item) === selected);
  return <div className="native-desk__layout"><section className="native-desk__queue"><section className="native-desk__lane"><h2>Calls</h2><RetainedWork read={read} selected={selected} onSelect={select} /><p>Account call allocation is unavailable until the daily workspace can be checked.</p></section><section className="native-desk__lane"><h2>Needs your approval</h2><p>Account approvals are unavailable until the daily workspace can be checked.</p></section><section className="native-desk__lane"><h2>Upcoming meetings</h2><p>Account meetings are unavailable until the daily workspace can be checked.</p></section></section><aside className="native-desk__detail" aria-label="Selected work">{entry ? <RetainedWorkDetail entry={entry} stale={read.error || read.pending} onOpenLead={onOpenLead} /> : selected ? <p>This work is no longer in the local queue.</p> : <p>Select retained work to review its local details.</p>}</aside></div>;
}
