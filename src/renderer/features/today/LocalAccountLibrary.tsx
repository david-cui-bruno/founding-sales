import { useState } from 'react';
import type { AccountEvidenceSnapshot } from '../../../shared/contracts/accountContract';
import type { LocalWorkspaceSnapshot } from '../../../shared/contracts/localWorkspaceContract';
import type { LocalRead } from './localWorkspaceRead';
export const localAccountKey = (id: string) => JSON.stringify(['local-account', id]);
export function LocalAccountLibrary({ read, selected, onSelect }: { read: LocalRead<LocalWorkspaceSnapshot>; selected: string | null; onSelect(key: string): void }) {
  return <section className="native-desk__lane" aria-labelledby="local-account-library"><h2 id="local-account-library">Local account library</h2><p>Stored local evidence only. Worker ownership is not established by this view.</p>
    {read.error ? <p role="status">Local account library is unavailable. {read.value && 'Saved evidence is stale.'} Refresh the local read.</p> : read.pending ? <p role="status">Checking local accounts…</p> : read.value?.accounts.state === 'unavailable' ? <p role="status">Local account library is unavailable. Refresh the local read.</p> : read.value?.accounts.snapshots.length === 0 ? <p>No local accounts in this snapshot.</p> : null}
    {(read.value?.accounts.state === 'available' ? read.value.accounts.snapshots : []).map(account => <button className="native-desk__row" key={localAccountKey(account.account.id)} data-row-key={localAccountKey(account.account.id)} aria-current={selected === localAccountKey(account.account.id) ? 'true' : undefined} aria-label={`Local account · ${account.account.name}`} onClick={() => onSelect(localAccountKey(account.account.id))}><strong>{account.account.name}</strong><small>Read-only local evidence</small></button>)}
  </section>;
}
export function LocalAccountDetail({ account }: { account: AccountEvidenceSnapshot }) {
  return <section className="native-desk__account"><h2>{account.account.name}</h2><p>{account.account.domain ?? 'Company domain not recorded'}</p><p>Local evidence, not worker authority or complete research.</p>
    {account.portfolio.map((p, i) => <p key={i}>{p.count} {p.scope} {p.measure}</p>)}
    {!account.portfolio.length && <p>Portfolio not recorded.</p>}
    {account.claims.map((c, i) => <div key={i}><p>{c.kind === 'hypothesis' ? 'Hypothesis' : c.kind === 'prospect_stated_problem' ? 'Prospect stated' : 'Fact'}: {typeof c.value === 'string' ? c.value : `${c.value.count} ${c.value.scope} ${c.value.measure}`}</p><small>Evidence: {c.evidenceIds.join(', ') || 'Unverified'}</small></div>)}
    {account.unknowns.map((u, i) => <p key={`u${i}`}>Unknown: {u}</p>)}{account.conflicts.map((c, i) => <p key={`c${i}`}>Conflict: {c}</p>)}
    {account.routes.map(route => <p key={route.id}>{route.channel}: {route.value} · {route.purpose} · {route.verification}<br /><small>Evidence: {route.evidenceIds.join(', ') || 'Unverified'}</small></p>)}
  </section>;
}

export function LocalOnlyAccountLibrary({ read, initialSelected = null, onSelectionChange }: { read: LocalRead<LocalWorkspaceSnapshot>; initialSelected?: string | null; onSelectionChange?(key: string): void }) {
  const [selected, setSelected] = useState<string | null>(initialSelected);
  const select = (key: string) => { setSelected(key); onSelectionChange?.(key); };
  const account = (read.value?.accounts.state === 'available' ? read.value.accounts.snapshots : []).find(a => localAccountKey(a.account.id) === selected);
  return <div className="native-desk__layout"><nav className="native-desk__queue" aria-label="Local accounts"><LocalAccountLibrary read={read} selected={selected} onSelect={select} /></nav><div className="native-desk__detail">{account && <LocalAccountDetail account={account} />}</div></div>;
}
