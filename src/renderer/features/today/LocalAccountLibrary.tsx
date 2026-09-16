import { Fragment, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { AccountEvidenceSnapshot } from '../../../shared/contracts/accountContract';
import type { LocalWorkspaceApi, LocalWorkspaceSnapshot } from '../../../shared/contracts/localWorkspaceContract';
import type { LocalRead } from './localWorkspaceRead';
import type { FirstUseContinuation } from './localCompanyContinuation';
import { LocalCompanyContactLink, type LocalCompanyContactApi } from './LocalCompanyContactLink';
import { LocalCompanyDraft } from './LocalCompanyDraft';
import { LocalCompanyResearchPanel } from './LocalCompanyResearchPanel';
import { preparationSummary, rankPreparationQueue } from './preparationQueue';
export const localAccountKey = (id: string) => JSON.stringify(['local-account', id]);
export type LocalAccountSelectionRequest = { key: string };
export function LocalAccountLibrary({ read, selected, onSelect, intake }: { intake?: ReactNode; read: LocalRead<LocalWorkspaceSnapshot>; selected: string | null; onSelect(key: string): void }) {
  // Row identity and label are unchanged. The ranked order and the per-company next step come only from the saved summary.
  const ranked = rankPreparationQueue(read.value?.accounts.state === 'available' ? read.value.accounts.snapshots : []);
  return <section className="native-desk__lane" aria-labelledby="local-account-library"><h2 id="local-account-library">Local account library</h2>{intake}<p>Stored local evidence only. Worker ownership is not established by this view.</p>
    {read.error ? <p role="status">Local account library is unavailable. {read.value && 'Saved evidence is stale.'} Refresh the local read.</p> : read.pending ? <p role="status">Checking local accounts…</p> : read.value?.accounts.state === 'unavailable' ? <p role="status">Local account library is unavailable. Refresh the local read.</p> : read.value?.accounts.snapshots.length === 0 ? <p>No local accounts in this snapshot.</p> : null}
    {ranked.some(account => account.preparation) && <p><small>Ordered by what is ready to prepare next, from saved local evidence. Each step opens the company; nothing starts on its own.</small></p>}
    {ranked.map(account => {
      const key = localAccountKey(account.account.id), summary = preparationSummary(account.preparation);
      return <Fragment key={key}>
        <button className="native-desk__row" data-row-key={key} aria-current={selected === key ? 'true' : undefined} aria-label={`Local account · ${account.account.name}`} onClick={() => onSelect(key)}><strong>{account.account.name}</strong><small>Read-only local evidence</small>{summary.reason && <span>{summary.reason}</span>}</button>
        {summary.label && <button type="button" className="native-desk__row-step" data-step-key={key} aria-label={`${summary.label} · ${account.account.name}`} style={{ margin: '0 var(--space-3) var(--space-2)' }} onClick={() => onSelect(key)}>{summary.label}</button>}
      </Fragment>;
    })}
  </section>;
}
export function LocalAccountDetail({ account, api, contactApi, continuation, onOpenImport, onOpenLead }: {
  account: AccountEvidenceSnapshot; api?: LocalWorkspaceApi;
  contactApi: Pick<LocalCompanyContactApi, 'leads' | 'leadDetail'>;
  continuation: FirstUseContinuation; onOpenImport(): void; onOpenLead(personId: string): void;
}) {
  const linkApi = useMemo(() => api ? { leads: contactApi.leads, leadDetail: contactApi.leadDetail, localWorkspace: api } : null, [api, contactApi.leads, contactApi.leadDetail]);
  return <section className="native-desk__account"><h2>{account.account.name}</h2><p>{account.account.domain ?? 'Company domain not recorded'}</p><p>Local evidence, not worker authority or complete research.</p>
    {api ? <LocalCompanyResearchPanel accountId={account.account.id} api={api} continuation={continuation} renderDetail={detail => <>{linkApi && <LocalCompanyContactLink detail={detail} api={linkApi} continuation={continuation} onOpenImport={onOpenImport} onOpenLead={onOpenLead} />}<LocalCompanyDraft api={api} detail={detail} /></>} /> : <>
    {account.portfolio.map((p, i) => <p key={i}>{p.count} {p.scope} {p.measure}</p>)}
    {!account.portfolio.length && <p>Portfolio not recorded.</p>}
    {account.claims.map((c, i) => <div key={i}><p>{c.kind === 'hypothesis' ? 'Hypothesis' : c.kind === 'prospect_stated_problem' ? 'Prospect stated' : 'Fact'}: {typeof c.value === 'string' ? c.value : `${c.value.count} ${c.value.scope} ${c.value.measure}`}</p><small>Evidence: {c.evidenceIds.join(', ') || 'Unverified'}</small></div>)}
    {account.unknowns.map((u, i) => <p key={`u${i}`}>Unknown: {u}</p>)}{account.conflicts.map((c, i) => <p key={`c${i}`}>Conflict: {c}</p>)}
    {account.routes.map(route => <p key={route.id}>{route.channel}: {route.value} · {route.purpose} · {route.verification}<br /><small>Evidence: {route.evidenceIds.join(', ') || 'Unverified'}</small></p>)}
    </>}
  </section>;
}

export function LocalOnlyAccountLibrary({ read, api, contactApi, onOpenImport, onOpenLead, firstUse, onSelectionChange, intake, selectionRequest, onSelectionHandled }: { api?: LocalWorkspaceApi; contactApi: Pick<LocalCompanyContactApi, 'leads' | 'leadDetail'>; onOpenImport(): void; onOpenLead(personId: string): void; firstUse: FirstUseContinuation; intake?: ReactNode; selectionRequest?: LocalAccountSelectionRequest | null; onSelectionHandled?(request: LocalAccountSelectionRequest): void; read: LocalRead<LocalWorkspaceSnapshot>; onSelectionChange?(key: string | null): void }) {
  const state = useSyncExternalStore(firstUse.subscribe, firstUse.snapshot, firstUse.snapshot);
  const epoch = firstUse.captureEpoch();
  const selected = state.selectedAccountId === null ? null : localAccountKey(state.selectedAccountId);
  const select = (key: string) => {
    const account = (read.value?.accounts.state === 'available' ? read.value.accounts.snapshots : []).find(item => localAccountKey(item.account.id) === key);
    if (!account || !firstUse.selectAccount(epoch, account.account.id)) return;
    onSelectionChange?.(key);
  };
  useEffect(() => {
    if (!selectionRequest) return;
    onSelectionHandled?.(selectionRequest);
  }, [selectionRequest, onSelectionHandled]);
  const close = () => {
    if (firstUse.selectAccount(epoch, null)) onSelectionChange?.(null);
  };
  const account = (read.value?.accounts.state === 'available' ? read.value.accounts.snapshots : []).find(a => localAccountKey(a.account.id) === selected);
  return <div className="native-desk__layout"><nav className="native-desk__queue" aria-label="Local accounts"><LocalAccountLibrary read={read} selected={selected} onSelect={select} intake={intake} /></nav><div className="native-desk__detail">{account && <><button type="button" aria-label="Close details" onClick={close}>Close</button><LocalAccountDetail account={account} api={api} contactApi={contactApi} continuation={firstUse} onOpenImport={onOpenImport} onOpenLead={onOpenLead} /></>}</div></div>;
}
