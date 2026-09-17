import { useState } from 'react';
import type { LocalCommitmentsSnapshot, LocalDraftContinuation } from '../../../shared/contracts/localWorkspaceContract';
import type { LocalRead } from './localWorkspaceRead';
import { formatVisibleCount, localCommitmentsCount } from './visibleCount';
export type RetainedItem = LocalCommitmentsSnapshot['items'][number];
export const retainedKey = ({ item }: RetainedItem) => JSON.stringify(['retained', item.salesCycleId, item.action.id]);
export const localDraftKey = (draft: Pick<LocalDraftContinuation, 'accountId' | 'draftId'>) => JSON.stringify(['local-draft', draft.accountId, draft.draftId]);
const labels: Record<RetainedItem['kind'], string> = { callback: 'Retained callback', post_stage: 'Post-stage follow-through', onboarding: 'Onboarding', inbound_response: 'Inbound response', warm_relationship: 'Existing relationship', founder_resurface: 'Founder resurface' };
export function RetainedWork({ read, selected, onSelect }: { read: LocalRead<LocalCommitmentsSnapshot>; selected: string | null; onSelect(key: string): void }) {
  return <div className="native-desk__retained">
    {read.error ? <p role="status">{read.value ? 'Retained work is stale. Refresh to check it again.' : 'Retained work could not be checked. Retry the local read.'}</p> : read.pending ? <p role="status">Checking retained work…</p> : null}
    {!!read.value?.reviewErrorCount && <p role="status">Some retained work could not be read. This local snapshot is incomplete.</p>}
    {read.value?.items.map(entry => <button key={retainedKey(entry)} type="button" className="native-desk__row" data-row-key={retainedKey(entry)} aria-current={selected === retainedKey(entry) ? 'true' : undefined} aria-label={`${labels[entry.kind]} · ${entry.item.personName} · ${entry.item.action.label}`} onClick={() => onSelect(retainedKey(entry))}>
      <strong>{entry.item.personName}</strong><small>{labels[entry.kind]}</small>{entry.item.contextLabel && <span className="native-desk__row-company">{entry.item.contextLabel}</span>}<span>{entry.item.action.label}</span>{entry.item.action.dueAt && <span>Due <time dateTime={entry.item.action.dueAt}>{new Date(entry.item.action.dueAt).toLocaleString(undefined, { timeZoneName: 'short' })}</time></span>}
    </button>)}
  </div>;
}
/** Unsent local company drafts listed under Saved draft continuations. Local evidence only: the row never claims worker
 *  ownership, and opening the company is navigation, never sending. */
export function LocalDraftContinuations({ drafts, onOpen }: { drafts: readonly LocalDraftContinuation[]; onOpen(draft: LocalDraftContinuation): void }) {
  if (!drafts.length) return null;
  return <div className="native-desk__local-drafts">
    <h3>Local unsent drafts</h3>
    {drafts.map(draft => <button key={localDraftKey(draft)} type="button" className="native-desk__row" data-row-key={localDraftKey(draft)}
      aria-label={`${draft.companyLabel} · Local unsent draft · revision ${draft.revision}`} onClick={() => onOpen(draft)}>
      <strong>{draft.companyLabel}</strong><small>Local unsent draft</small>
      {draft.subject && <span>{draft.subject}</span>}
      <span>Saved locally · revision {draft.revision}</span>
    </button>)}
  </div>;
}
/** Pure presentation. No inspector, preparation, composer or command API mounts. */
export function RetainedWorkDetail({ entry }: { entry: RetainedItem }) {
  const { item } = entry;
  return <section aria-label="Retained work detail"><h2>{item.personName}</h2><p>{labels[entry.kind]}</p><p>{item.contextLabel}</p><h3>{item.action.label}</h3><p>{item.reason}</p><p>Action type: {item.action.type} · Channel: {item.action.channel} · Lane: {item.lane}</p>
    <p>{item.action.dueAt ? <time dateTime={item.action.dueAt}>{new Date(item.action.dueAt).toLocaleString(undefined, { timeZoneName: 'short' })}</time> : 'Time not recorded'}</p>
    {item.consentRequirement && <p>{item.consentRequirement}</p>}
    <p>Stored local work. Nothing here calls, sends or books.</p>
  </section>;
}
export function LocalOnlyCalls({ read, onOpenDraft, initialSelected = null, onSelectionChange }: { read: LocalRead<LocalCommitmentsSnapshot>; onOpenDraft?(draft: LocalDraftContinuation): void; initialSelected?: string | null; onSelectionChange?(key: string): void }) {
  const [selected, setSelected] = useState<string | null>(initialSelected);
  const select = (key: string) => { setSelected(key); onSelectionChange?.(key); };
  const entry = read.value?.items.find(item => retainedKey(item) === selected);
  return <div className="native-desk__layout">
    <section className="native-desk__queue">
      <section className="native-desk__lane"><h2>Local commitments <span className="native-desk__count">{formatVisibleCount(localCommitmentsCount(read))}</span></h2><RetainedWork read={read} selected={selected} onSelect={select} /></section>
      {['Calls', 'Saved draft continuations', 'Upcoming meetings'].map(label => <section className="native-desk__lane" key={label}><h2>{label} <span className="native-desk__count">Unavailable</span></h2>
        {label === 'Saved draft continuations' && onOpenDraft && <LocalDraftContinuations drafts={read.value?.localDrafts ?? []} onOpen={onOpenDraft} />}
      </section>)}
    </section>
    <aside className="native-desk__detail" aria-label="Selected work">{entry ? <RetainedWorkDetail entry={entry} /> : selected ? <p>This work is no longer in the local queue.</p> : <div className="native-desk__welcome"><h2>Local work, separate from worker actions.</h2><p>Local work remains available. Worker-scoped work is unavailable until the daily workspace can be checked.</p><a href="#/settings">Review Settings</a></div>}</aside>
  </div>;
}
