import { Fragment, useEffect, useMemo, useRef, useSyncExternalStore, type ComponentProps, type ComponentType, type ReactNode } from 'react';
import type { AccountEvidenceSnapshot } from '../../../shared/contracts/accountContract';
import type { LocalAccountPreparationStep, LocalWorkspaceApi, LocalWorkspaceSnapshot } from '../../../shared/contracts/localWorkspaceContract';
import type { LocalRead } from './localWorkspaceRead';
import type { FirstUseContinuation } from './localCompanyContinuation';
import { LocalCompanyContactLink, type LocalCompanyContactApi } from './LocalCompanyContactLink';
import { LocalCompanyDraft } from './LocalCompanyDraft';
import { LocalCompanyPhoneRoute } from './LocalCompanyPhoneRoute';
import { LocalCompanyResearchPanel } from './LocalCompanyResearchPanel';
import { preparationSummary, rankPreparationQueue } from './preparationQueue';
export const localAccountKey = (id: string) => JSON.stringify(['local-account', id]);
export type LocalAccountSelectionRequest = { key: string };
/** A step control names a panel of the selected company. Handling it scrolls that panel into view and moves focus there. */
export type LocalAccountStepRequest = { accountId: string; step: LocalAccountPreparationStep };
// A step requested on one route (a Today draft row) and taken on the Accounts route after its remount. Keyed by the
// local API lifetime, like view selection; a replaced API forgets it.
const pendingSteps = new WeakMap<LocalWorkspaceApi, LocalAccountStepRequest>();
export function requestLocalAccountStep(api: LocalWorkspaceApi, request: LocalAccountStepRequest) { pendingSteps.set(api, request); }
export function takeLocalAccountStep(api: LocalWorkspaceApi): LocalAccountStepRequest | null {
  const request = pendingSteps.get(api) ?? null;
  pendingSteps.delete(api);
  return request;
}
/** The panel each step names. Route review happens in the company draft panel's inbox review; an unknown step opens the company itself. */
export function preparationStepTarget(root: HTMLElement, step: LocalAccountPreparationStep): HTMLElement | null {
  switch (step) {
    case 'reopen_draft': case 'draft': case 'add_route': return root.querySelector<HTMLElement>('section[aria-label="Company draft"]');
    case 'research': return [...root.querySelectorAll<HTMLElement>('h3')].find(heading => heading.textContent === 'Company research') ?? null;
    case 'unknown': return root;
  }
}
// Lane 6 adds `onEvidenceChanged` to LocalCompanyDraft and calls it after an admission or opening. Until it lands, the
// route passes the prop through this optional type so both branches merge cleanly without editing that file.
const CompanyDraft = LocalCompanyDraft as ComponentType<ComponentProps<typeof LocalCompanyDraft> & { onEvidenceChanged?: () => void }>;
export function LocalAccountLibrary({ read, selected, onSelect, onStep, intake }: { intake?: ReactNode; read: LocalRead<LocalWorkspaceSnapshot>; selected: string | null; onSelect(key: string): void; onStep?(key: string, step: LocalAccountPreparationStep): void }) {
  // Row identity and label are unchanged. The ranked order and the per-company next step come only from the saved summary.
  const ranked = rankPreparationQueue(read.value?.accounts.state === 'available' ? read.value.accounts.snapshots : []);
  return <section className="native-desk__lane" aria-labelledby="local-account-library"><h2 id="local-account-library">Local account library</h2>{intake}<p>Stored local evidence only. Worker ownership is not established by this view.</p>
    {read.error ? <p role="status">Local account library is unavailable. {read.value && 'Saved evidence is stale.'} Refresh the local read.</p> : read.pending ? <p role="status">Checking local accounts…</p> : read.value?.accounts.state === 'unavailable' ? <p role="status">Local account library is unavailable. Refresh the local read.</p> : read.value?.accounts.snapshots.length === 0 ? <p>No local accounts in this snapshot.</p> : null}
    {ranked.some(account => account.preparation) && <p><small>Ordered by what is ready to prepare next, from saved local evidence. Each step opens the company; nothing starts on its own.</small></p>}
    {ranked.map(account => {
      const key = localAccountKey(account.account.id), summary = preparationSummary(account.preparation), step = account.preparation?.nextStep;
      return <Fragment key={key}>
        <button className="native-desk__row" data-row-key={key} aria-current={selected === key ? 'true' : undefined} aria-label={`Local account · ${account.account.name}`} onClick={() => onSelect(key)}><strong>{account.account.name}</strong><small>Read-only local evidence</small>{summary.reason && <span>{summary.reason}</span>}</button>
        {summary.label && step && <button type="button" className="native-desk__row-step" data-step-key={key} aria-label={`${summary.label} · ${account.account.name}`} onClick={() => onStep ? onStep(key, step) : onSelect(key)}>{summary.label}</button>}
      </Fragment>;
    })}
  </section>;
}
export function LocalAccountDetail({ account, api, contactApi, continuation, step = null, onStepHandled, onEvidenceChanged }: {
  account: AccountEvidenceSnapshot; api?: LocalWorkspaceApi;
  contactApi: Pick<LocalCompanyContactApi, 'leads' | 'leadDetail'>;
  continuation: FirstUseContinuation;
  step?: LocalAccountStepRequest | null; onStepHandled?(request: LocalAccountStepRequest): void; onEvidenceChanged?(): void;
}) {
  const linkApi = useMemo(() => api ? { leads: contactApi.leads, leadDetail: contactApi.leadDetail, localWorkspace: api } : null, [api, contactApi.leads, contactApi.leadDetail]);
  const root = useRef<HTMLElement>(null);
  const handled = useRef(onStepHandled);
  handled.current = onStepHandled;
  useEffect(() => {
    const section = root.current;
    if (!step || !section || step.accountId !== account.account.id) return;
    // The named panel renders after the company detail read settles, so wait for it; the step dies with this view otherwise.
    let frame: number | null = null, observer: MutationObserver | null = null, found = false;
    const reveal = () => {
      const target = preparationStepTarget(section, step.step);
      if (!target || found) return;
      found = true; observer?.disconnect();
      frame = requestAnimationFrame(() => {
        frame = null;
        target.scrollIntoView?.({ block: 'start' });
        if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
        target.focus({ preventScroll: true });
        handled.current?.(step);
      });
    };
    reveal();
    if (!found) { observer = new MutationObserver(reveal); observer.observe(section, { childList: true, subtree: true }); }
    return () => { observer?.disconnect(); if (frame !== null) cancelAnimationFrame(frame); };
  }, [step, account.account.id]);
  return <section className="native-desk__account" ref={root}><h2>{account.account.name}</h2><p>{account.account.domain ?? 'Company domain not recorded'}</p><p>Local evidence, not worker authority or complete research.</p>
    {api ? <LocalCompanyResearchPanel accountId={account.account.id} api={api} continuation={continuation} renderDetail={detail => <>{linkApi && <LocalCompanyContactLink detail={detail} api={linkApi} continuation={continuation} />}<CompanyDraft api={api} detail={detail} onEvidenceChanged={onEvidenceChanged} /><LocalCompanyPhoneRoute api={api} detail={detail} onEvidenceChanged={onEvidenceChanged} /></>} /> : <>
    {account.portfolio.map((p, i) => <p key={i}>{p.count} {p.scope} {p.measure}</p>)}
    {!account.portfolio.length && <p>Portfolio not recorded.</p>}
    {account.claims.map((c, i) => <div key={i}><p>{c.kind === 'hypothesis' ? 'Hypothesis' : c.kind === 'prospect_stated_problem' ? 'Prospect stated' : 'Fact'}: {typeof c.value === 'string' ? c.value : `${c.value.count} ${c.value.scope} ${c.value.measure}`}</p><small>Evidence: {c.evidenceIds.join(', ') || 'Unverified'}</small></div>)}
    {account.unknowns.map((u, i) => <p key={`u${i}`}>Unknown: {u}</p>)}{account.conflicts.map((c, i) => <p key={`c${i}`}>Conflict: {c}</p>)}
    {account.routes.map(route => <p key={route.id}>{route.channel}: {route.value} · {route.purpose} · {route.verification}<br /><small>Evidence: {route.evidenceIds.join(', ') || 'Unverified'}</small></p>)}
    </>}
  </section>;
}

export function LocalOnlyAccountLibrary({ read, api, contactApi, firstUse, onSelectionChange, intake, selectionRequest, onSelectionHandled, stepRequest, onStep, onStepHandled, onEvidenceChanged }: { api?: LocalWorkspaceApi; contactApi: Pick<LocalCompanyContactApi, 'leads' | 'leadDetail'>; firstUse: FirstUseContinuation; intake?: ReactNode; selectionRequest?: LocalAccountSelectionRequest | null; onSelectionHandled?(request: LocalAccountSelectionRequest): void; read: LocalRead<LocalWorkspaceSnapshot>; onSelectionChange?(key: string | null): void; stepRequest?: LocalAccountStepRequest | null; onStep?(request: LocalAccountStepRequest): void; onStepHandled?(request: LocalAccountStepRequest): void; onEvidenceChanged?(): void }) {
  const state = useSyncExternalStore(firstUse.subscribe, firstUse.snapshot, firstUse.snapshot);
  const epoch = firstUse.captureEpoch();
  const selected = state.selectedAccountId === null ? null : localAccountKey(state.selectedAccountId);
  const snapshots = read.value?.accounts.state === 'available' ? read.value.accounts.snapshots : [];
  const select = (key: string) => {
    const account = snapshots.find(item => localAccountKey(item.account.id) === key);
    if (!account || !firstUse.selectAccount(epoch, account.account.id)) return null;
    onSelectionChange?.(key);
    return account.account.id;
  };
  useEffect(() => {
    if (!selectionRequest) return;
    onSelectionHandled?.(selectionRequest);
  }, [selectionRequest, onSelectionHandled]);
  const close = () => {
    if (firstUse.selectAccount(epoch, null)) onSelectionChange?.(null);
  };
  const account = snapshots.find(a => localAccountKey(a.account.id) === selected);
  return <div className="native-desk__layout"><nav className="native-desk__queue" aria-label="Local accounts"><LocalAccountLibrary read={read} selected={selected} onSelect={select} onStep={(key, step) => { const accountId = select(key); if (accountId !== null) onStep?.({ accountId, step }); }} intake={intake} /></nav><div className="native-desk__detail">{account && <><button type="button" aria-label="Close details" onClick={close}>Close</button><LocalAccountDetail account={account} api={api} contactApi={contactApi} continuation={firstUse} step={stepRequest?.accountId === account.account.id ? stepRequest : null} onStepHandled={onStepHandled} onEvidenceChanged={onEvidenceChanged} /></>}</div></div>;
}
