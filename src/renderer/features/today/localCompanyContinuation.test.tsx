// @vitest-environment jsdom
import { StrictMode, useSyncExternalStore } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LinkCompanyPersonRequest, LocalCompanyResearchStatus, SelectedResearch } from '../../../shared/contracts/localWorkspaceContract';
import { createLocalCompanyContinuation, type FirstUseContinuation } from './localCompanyContinuation';
import { useFirstUseContinuation, type IntakeApi } from './LocalCompanyIntake';
import { LocalCompanyIntakeProvider } from './LocalCompanyIntakeProvider';

const request = (accountId = 'a', suffix = '1'): Readonly<SelectedResearch> => Object.freeze({ accountId, commandId: `10000000-0000-4000-8000-${suffix.padStart(12, '0')}` });
const status = (r: Readonly<SelectedResearch>, state: LocalCompanyResearchStatus['state']): LocalCompanyResearchStatus => ({ ...r, state, receipt: state === 'completed' ? { accountId: r.accountId, version: 2, duplicate: false } : null, reason: state === 'held' ? 'capability_unavailable' : null });
const bundles: ReturnType<typeof createLocalCompanyContinuation>[] = [];
function active() { const bundle = createLocalCompanyContinuation(); bundles.push(bundle); bundle.activate(); bundle.continuation.selectAccount(bundle.continuation.captureEpoch(), 'a'); return bundle; }
function mustBegin(c: FirstUseContinuation, r: Readonly<SelectedResearch>) { const token = c.beginResearch(c.captureEpoch(), r); expect(token).not.toBeNull(); return token!; }
function mustCheck(c: FirstUseContinuation, r: Readonly<SelectedResearch>) { const token = c.beginResearchStatus(c.captureEpoch(), r); expect(token).not.toBeNull(); return token!; }
afterEach(() => { cleanup(); for (const bundle of bundles.splice(0)) bundle.invalidate(); vi.restoreAllMocks(); });

describe('first-use owner contract', () => {
  it('F4-owner-01 rejects inactive and foreign epochs while activation replaces the cached snapshot', () => {
    const bundle = createLocalCompanyContinuation(); bundles.push(bundle);
    const c = bundle.continuation; const cold = c.captureEpoch(); const initial = c.snapshot(); const r = request();
    expect(c.snapshot()).toBe(initial); expect(c.isCurrent(cold)).toBe(false);
    expect(c.selectAccount(cold, 'a')).toBe(false); expect(c.beginResearch(cold, r)).toBeNull();
    expect(c.beginResearchStatus(cold, r)).toBeNull();
    bundle.activate(); const epoch = c.captureEpoch(); expect(epoch).not.toBe(cold); expect(c.isCurrent(epoch)).toBe(true);
    expect(c.snapshot()).not.toBe(initial); expect(c.selectAccount(epoch, 'a')).toBe(true);
    const other = active().continuation; expect(other.selectAccount(epoch, 'b')).toBe(false);
    expect(other.beginResearch(epoch, r)).toBeNull(); expect(c.snapshot().selectedAccountId).toBe('a');
  }, 10_000);

  it('F4-owner-02 snapshots are cached and deeply immutable without freezing caller-owned status', () => {
    const { continuation: c } = active(); const r = request(); const token = mustBegin(c, r);
    const supplied = status(r, 'completed'); const receipt = supplied.receipt!;
    expect(c.settleResearch(token, { outcome: 'known', status: supplied })).toBe(true);
    const snapshot = c.snapshot(); expect(c.snapshot()).toBe(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.research)).toBe(true);
    expect(Object.isFrozen(snapshot.research!.request)).toBe(true); expect(Object.isFrozen(snapshot.research!.status)).toBe(true);
    expect(Object.isFrozen(snapshot.research!.status!.receipt)).toBe(true);
    expect(Object.isFrozen(supplied)).toBe(false); expect(Object.isFrozen(receipt)).toBe(false);
    supplied.reason = 'caller changed'; receipt.version = 99;
    expect(snapshot.research!.status!.reason).toBeNull(); expect(snapshot.research!.status!.receipt!.version).toBe(2);
    expect(snapshot.research!.request).toBe(r);
  }, 10_000);

  it('F4-owner-03 notifies subscribers on lifecycle and changes and honors unsubscribe', () => {
    const bundle = createLocalCompanyContinuation(); bundles.push(bundle); const c = bundle.continuation;
    const observed: ReturnType<FirstUseContinuation['snapshot']>[] = [];
    const off = c.subscribe(() => observed.push(c.snapshot())); const cold = c.snapshot();
    bundle.activate(); expect(observed.at(-1)).toBe(c.snapshot()); expect(c.snapshot()).not.toBe(cold);
    c.selectAccount(c.captureEpoch(), 'a'); expect(observed.at(-1)!.selectedAccountId).toBe('a');
    const before = c.snapshot(); bundle.invalidate(); expect(observed.at(-1)).not.toBe(before);
    const count = observed.length; off(); bundle.activate(); c.selectAccount(c.captureEpoch(), 'b'); expect(observed).toHaveLength(count);
  }, 10_000);

  it('F4-owner-04 reserves synchronously and only admits the selected account', () => {
    const { continuation: c } = active(); const r = request();
    expect(c.beginResearch(c.captureEpoch(), request('b'))).toBeNull();
    const token = mustBegin(c, r); expect(c.snapshot().research).toEqual({ request: r, outcome: 'pending', status: null });
    expect(c.beginResearch(c.captureEpoch(), r)).toBeNull(); expect(c.beginResearch(c.captureEpoch(), request('a', '2'))).toBeNull();
    expect(c.settleResearch(token, { outcome: 'known', status: status(r, 'completed') })).toBe(true);
    expect(c.snapshot().research!.outcome).toBe('known');
  }, 10_000);

  it.each(['unknown', 'not_recorded', 'queued', 'running'] as const)('F4-owner-05 unresolved %s blocks B without erasing A and permits exact recovery', state => {
    const { continuation: c } = active(); const r = request(); const token = mustBegin(c, r);
    c.settleResearch(token, state === 'unknown' ? { outcome: 'unknown' } : { outcome: 'known', status: status(r, state) });
    const held = c.snapshot().research; c.selectAccount(c.captureEpoch(), 'b');
    expect(c.beginResearch(c.captureEpoch(), request('b', '2'))).toBeNull(); expect(c.snapshot().research).toBe(held);
    c.selectAccount(c.captureEpoch(), null); expect(c.snapshot().research).toBe(held);
    c.selectAccount(c.captureEpoch(), 'a'); const replay = mustBegin(c, r);
    expect(c.snapshot().research!.request).toBe(r); expect(c.beginResearch(c.captureEpoch(), r)).toBeNull();
    c.settleResearch(replay, { outcome: 'known', status: status(r, 'completed') }); expect(c.snapshot().research!.status!.state).toBe('completed');
  }, 10_000);

  it.each(['completed', 'held', 'parked'] as const)('F4-owner-06 permits deliberate new request only after known %s', state => {
    const { continuation: c } = active(); const r = request(); c.settleResearch(mustBegin(c, r), { outcome: 'known', status: status(r, state) });
    if (state === 'parked') expect(c.beginResearch(c.captureEpoch(), r)).toBeNull();
    c.selectAccount(c.captureEpoch(), 'b'); const next = request('b', '2'); const token = mustBegin(c, next);
    expect(c.snapshot().research!.request).toBe(next); c.settleResearch(token, { outcome: 'known', status: status(next, 'completed') });
  }, 10_000);

  it('F4-owner-07 Check while pending displays status without releasing execution and preserves current selection', () => {
    const { continuation: c } = active(); const r = request(); const execution = mustBegin(c, r); const check = mustCheck(c, r);
    c.selectAccount(c.captureEpoch(), 'b'); expect(c.acceptResearchStatus(check, status(r, 'not_recorded'))).toBe(true);
    expect(c.snapshot().selectedAccountId).toBe('b'); expect(c.snapshot().research!.outcome).toBe('pending');
    expect(c.snapshot().research!.status!.state).toBe('not_recorded');
    c.selectAccount(c.captureEpoch(), 'a'); expect(c.beginResearch(c.captureEpoch(), r)).toBeNull();
    c.settleResearch(execution, { outcome: 'known', status: status(r, 'completed') }); expect(c.snapshot().research!.status!.state).toBe('completed');
  }, 10_000);

  it.each(['known', 'unknown'] as const)('F4-owner-08 execution %s settlement fences checks before and during same-request Resume', outcome => {
    const { continuation: c } = active(); const r = request(); c.settleResearch(mustBegin(c, r), { outcome: 'unknown' });
    const before = mustCheck(c, r); const replay = mustBegin(c, r);
    expect(c.acceptResearchStatus(before, status(r, 'queued'))).toBe(false);
    const during = mustCheck(c, r); c.selectAccount(c.captureEpoch(), 'b');
    c.settleResearch(replay, outcome === 'known' ? { outcome, status: status(r, 'completed') } : { outcome });
    const settled = c.snapshot(); expect(c.acceptResearchStatus(during, status(r, 'running'))).toBe(false);
    expect(c.snapshot()).toBe(settled); expect(c.snapshot().selectedAccountId).toBe('b');
    const fresh = mustCheck(c, r); expect(c.acceptResearchStatus(fresh, status(r, 'completed'))).toBe(true);
    expect(c.snapshot().research!.status!.state).toBe('completed'); expect(c.snapshot().research!.outcome).toBe('known');
  }, 10_000);

  it('F4-owner-09 latest status observation wins without invalidating live execution', () => {
    const { continuation: c } = active(); const r = request(); const execution = mustBegin(c, r);
    const old = mustCheck(c, r); const fresh = mustCheck(c, r);
    expect(c.acceptResearchStatus(fresh, status(r, 'running'))).toBe(true);
    expect(c.acceptResearchStatus(old, status(r, 'queued'))).toBe(false);
    expect(c.snapshot().research!.status!.state).toBe('running'); expect(c.snapshot().research!.outcome).toBe('pending');
    expect(c.settleResearch(execution, { outcome: 'known', status: status(r, 'completed') })).toBe(true);
  }, 10_000);

  it.each(['account', 'command', 'receipt'] as const)('F4-owner-10 rejects mismatched %s Check and releases mismatched execution to recoverable unknown', mismatch => {
    const { continuation: c } = active(); const r = request(); const execution = mustBegin(c, r); const check = mustCheck(c, r);
    const wrong = status(r, 'completed'); if (mismatch === 'account') wrong.accountId = 'b';
    if (mismatch === 'command') wrong.commandId = request('a', '2').commandId;
    if (mismatch === 'receipt') wrong.receipt!.accountId = 'b';
    const before = c.snapshot(); expect(c.acceptResearchStatus(check, wrong)).toBe(false); expect(c.snapshot()).toBe(before);
    c.settleResearch(execution, { outcome: 'known', status: wrong });
    expect(c.snapshot().research!.outcome).toBe('unknown'); expect(c.snapshot().research!.request).toBe(r);
    expect(c.snapshot().research!.status).toBeNull();
    const replay = mustBegin(c, r); expect(c.settleResearch(replay, { outcome: 'known', status: status(r, 'completed') })).toBe(true);
  }, 10_000);

  it('F4-owner-11 invalidation retains last status and permanently fences old success/rejection after reactivation', () => {
    const bundle = active(); const c = bundle.continuation; const r = request(); const oldEpoch = c.captureEpoch();
    const oldExecution = mustBegin(c, r); const oldCheck = mustCheck(c, r); c.acceptResearchStatus(oldCheck, status(r, 'running'));
    bundle.invalidate(); expect(c.snapshot().research).toEqual({ request: r, outcome: 'unknown', status: status(r, 'running') });
    expect(c.isCurrent(oldEpoch)).toBe(false); bundle.activate(); expect(c.captureEpoch()).not.toBe(oldEpoch);
    expect(c.selectAccount(oldEpoch, 'b')).toBe(false); const replay = mustBegin(c, r); const pending = c.snapshot();
    expect(c.settleResearch(oldExecution, { outcome: 'known', status: status(r, 'completed') })).toBe(false);
    expect(c.settleResearch(oldExecution, { outcome: 'unknown' })).toBe(false);
    expect(c.acceptResearchStatus(oldCheck, status(r, 'queued'))).toBe(false); expect(c.snapshot()).toBe(pending);
    c.settleResearch(replay, { outcome: 'known', status: status(r, 'completed') });
    expect(c.snapshot().research!.status!.state).toBe('completed'); expect(c.snapshot().research!.request).toBe(r);
  }, 10_000);
});

function intakeApi(): IntakeApi { return { reviewCompany: vi.fn<IntakeApi['reviewCompany']>(async input => ({ scope: 'local_database', input, candidates: [], complete: true })), createCompany: vi.fn<IntakeApi['createCompany']>(async () => { throw Error('not used'); }), getCompanyCreateStatus: vi.fn<IntakeApi['getCompanyCreateStatus']>(async () => { throw Error('not used'); }) }; }
// Thin consumer of the real public hook, not a replacement controller or owner.
function Observe({ id, captures, handlers, invoke }: { id: string; captures: Record<string, FirstUseContinuation>; handlers?: Record<string, () => void>; invoke?: (r: Readonly<SelectedResearch>) => void }) {
  const c = useFirstUseContinuation(); const state = useSyncExternalStore(c.subscribe, c.snapshot, c.snapshot);
  captures[id] = c; const epoch = c.captureEpoch();
  const begin = () => { if (!c.selectAccount(epoch, 'a')) return; const r = request(); if (c.beginResearch(epoch, r)) invoke?.(r); };
  if (handlers) handlers[id] = begin;
  return <button onClick={begin}>{id}:{state.research?.outcome ?? 'empty'}</button>;
}

describe('real intake-owned first-use lifecycle', () => {
  it('F4-provider-01 matching nested borrower teardown preserves ancestor pending and exact adapter', () => {
    const api = intakeApi(); const captures: Record<string, FirstUseContinuation> = {};
    const tree = (nested: boolean) => <LocalCompanyIntakeProvider api={api}><Observe id="outer" captures={captures} />{nested ? <LocalCompanyIntakeProvider api={api}><Observe id="inner" captures={captures} /></LocalCompanyIntakeProvider> : null}</LocalCompanyIntakeProvider>;
    const view = render(tree(true)); expect(captures.inner).toBe(captures.outer);
    fireEvent.click(screen.getByRole('button', { name: 'inner:empty' })); const original = captures.outer.snapshot().research!.request;
    view.rerender(tree(false)); expect(captures.outer.snapshot().research!.outcome).toBe('pending'); expect(captures.outer.snapshot().research!.request).toBe(original);
    expect(api.reviewCompany).not.toHaveBeenCalled(); expect(api.createCompany).not.toHaveBeenCalled();
  }, 10_000);

  it('F4-provider-02 API A to B to A never resurrects old state or accepts old execution', () => {
    const a = intakeApi(); const b = intakeApi(); const captures: Record<string, FirstUseContinuation> = {};
    const tree = (api: IntakeApi) => <LocalCompanyIntakeProvider api={api}><Observe id="view" captures={captures} /></LocalCompanyIntakeProvider>;
    const view = render(tree(a)); const old = captures.view; const r = request(); let oldToken!: ReturnType<typeof mustBegin>;
    act(() => { old.selectAccount(old.captureEpoch(), 'a'); oldToken = mustBegin(old, r); });
    view.rerender(tree(b)); const middle = captures.view; expect(middle).not.toBe(old); fireEvent.click(screen.getByRole('button', { name: 'view:empty' }));
    view.rerender(tree(a)); const fresh = captures.view; expect(fresh).not.toBe(old); expect(fresh).not.toBe(middle);
    expect(fresh.snapshot().research).toBeNull(); expect(old.settleResearch(oldToken, { outcome: 'known', status: status(r, 'completed') })).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'view:empty' })); expect(fresh.snapshot().research!.outcome).toBe('pending');
  }, 10_000);

  it('F4-provider-03 StrictMode activation leaves actionable handlers and owned teardown fences captured pre-IPC closure', async () => {
    const api = intakeApi(); const captures: Record<string, FirstUseContinuation> = {}; const handlers: Record<string, () => void> = {}; const invoke = vi.fn();
    const view = render(<StrictMode><LocalCompanyIntakeProvider api={api}><Observe id="live" captures={captures} handlers={handlers} invoke={invoke} /></LocalCompanyIntakeProvider></StrictMode>);
    await waitFor(() => expect(captures.live.isCurrent(captures.live.captureEpoch())).toBe(true));
    const old = handlers.live; fireEvent.click(screen.getByRole('button', { name: 'live:empty' }));
    expect(invoke).toHaveBeenCalledOnce(); expect(captures.live.snapshot().research!.outcome).toBe('pending');
    view.unmount(); act(() => old()); expect(invoke).toHaveBeenCalledOnce();
    render(<StrictMode><LocalCompanyIntakeProvider api={api}><Observe id="new" captures={captures} handlers={handlers} invoke={invoke} /></LocalCompanyIntakeProvider></StrictMode>);
    fireEvent.click(screen.getByRole('button', { name: 'new:empty' })); expect(invoke).toHaveBeenCalledTimes(2);
    expect(captures.new).not.toBe(captures.live);
  }, 10_000);

  it('F4-provider-04 replacing an owned nested B with borrowed A then B cannot dispose A or resurrect B', () => {
    const a = intakeApi(); const b = intakeApi(); const captures: Record<string, FirstUseContinuation> = {};
    const tree = (inner: IntakeApi) => <LocalCompanyIntakeProvider api={a}><Observe id="outer" captures={captures} /><LocalCompanyIntakeProvider api={inner}><Observe id="inner" captures={captures} /></LocalCompanyIntakeProvider></LocalCompanyIntakeProvider>;
    const view = render(tree(b)); fireEvent.click(screen.getByRole('button', { name: 'outer:empty' })); fireEvent.click(screen.getByRole('button', { name: 'inner:empty' }));
    const outer = captures.outer; const discarded = captures.inner; const retained = outer.snapshot().research!.request;
    view.rerender(tree(a)); expect(captures.inner).toBe(outer); expect(outer.snapshot().research!.outcome).toBe('pending');
    view.rerender(tree(b)); expect(captures.inner).not.toBe(discarded); expect(captures.inner.snapshot().research).toBeNull();
    expect(outer.snapshot().research!.request).toBe(retained); expect(outer.snapshot().research!.outcome).toBe('pending');
  }, 10_000);
});


it('F4-owner-12 parked during pending then rejection forbids same-request Resume until explicit known-terminal new intent', () => {
  const { continuation: c } = active(); const r = request(); const execution = mustBegin(c, r);
  expect(c.acceptResearchStatus(mustCheck(c, r), status(r, 'parked'))).toBe(true);
  expect(c.snapshot().research!.outcome).toBe('pending');
  expect(c.settleResearch(execution, { outcome: 'unknown' })).toBe(true);
  expect(c.snapshot().research!.outcome).toBe('unknown'); expect(c.snapshot().research!.status!.state).toBe('parked');
  expect(c.beginResearch(c.captureEpoch(), r)).toBeNull(); expect(c.beginResearch(c.captureEpoch(), request('a', '2'))).toBeNull();
  expect(c.acceptResearchStatus(mustCheck(c, r), status(r, 'parked'))).toBe(true);
  expect(c.snapshot().research!.outcome).toBe('known'); expect(c.beginResearch(c.captureEpoch(), r)).toBeNull();
  const next = request('a', '2'); expect(c.beginResearch(c.captureEpoch(), next)).not.toBeNull(); expect(c.snapshot().research!.request).toBe(next);
}, 10_000);


it('F4-owner-13 execution and observation tokens from another owner cannot mutate identical account and command', () => {
  const one = active().continuation; const two = active().continuation; const r = request();
  const foreignExecution = mustBegin(one, r); const foreignObservation = mustCheck(one, r);
  const ownExecution = mustBegin(two, r); const before = two.snapshot();
  expect(two.settleResearch(foreignExecution, { outcome: 'known', status: status(r, 'completed') })).toBe(false);
  expect(two.acceptResearchStatus(foreignObservation, status(r, 'completed'))).toBe(false); expect(two.snapshot()).toBe(before);
  expect(two.settleResearch(ownExecution, { outcome: 'known', status: status(r, 'completed') })).toBe(true);
}, 10_000);

it('F4-owner-14 a settled execution token cannot overwrite its same-epoch same-request replay', () => {
  const { continuation: c } = active(); const r = request(); const first = mustBegin(c, r);
  c.settleResearch(first, { outcome: 'unknown' }); const replay = mustBegin(c, r); const pending = c.snapshot();
  expect(c.settleResearch(first, { outcome: 'known', status: status(r, 'completed') })).toBe(false);
  expect(c.settleResearch(first, { outcome: 'unknown' })).toBe(false); expect(c.snapshot()).toBe(pending);
  c.settleResearch(replay, { outcome: 'known', status: status(r, 'completed') }); expect(c.snapshot().research!.status!.state).toBe('completed');
}, 10_000);


// Task 6: real continuation owner, synthetic reviewed requests, no transport/storage.
function t6Request(accountId = 'a', suffix = '1'): LinkCompanyPersonRequest {
  return { commandId: `60000000-0000-4000-8000-${suffix.padStart(12, '0')}`, accountId, expectedVersion: 1,
    link: { id: `link-${suffix}`, kind: 'person_role', personId: 'person-51', role: 'Manager', relationship: 'Manages company',
      evidenceIds: ['source-a'], validFrom: '2026-09-10T12:00:00.000Z', validTo: null, authority: 'unconfirmed', authorityEvidenceIds: [] },
    sourceQuotes: [{ sourceId: 'source-a', quote: 'Avery manages company A.' }] };
}
function t6Review(accountId = 'a') { return { accountId, personId: 'person-51', role: 'Manager', relationship: 'Manages company', sourceQuotes: [{ sourceId: 'source-a', quote: 'Avery manages company A.' }] }; }
function t6Begin(c: FirstUseContinuation, input = t6Request()) {
  const token = c.beginLink(c.captureEpoch(), input); expect(token).not.toBeNull(); return token!;
}
it('T6-O01 initial and published review snapshots are stable deep copies, not mutable caller aliases', () => {
  const c = active().continuation;
  expect(c.snapshot().link).toBeNull();
  expect(c.snapshot().review).toEqual({ accountId: null, personId: null, role: '', relationship: '', sourceQuotes: [] });
  const input = t6Review(); expect(c.updateReview(c.captureEpoch(), input)).toBe(true);
  const before = c.snapshot(); expect(c.snapshot()).toBe(before);
  expect(Object.isFrozen(before)).toBe(true); expect(Object.isFrozen(before.review)).toBe(true);
  expect(Object.isFrozen(before.review.sourceQuotes)).toBe(true); expect(Object.isFrozen(before.review.sourceQuotes[0])).toBe(true);
  input.role = 'Tampered'; input.sourceQuotes[0].quote = 'Changed'; input.sourceQuotes.push({ sourceId: 'other', quote: 'Other' });
  expect(before.review).toEqual(t6Review()); expect(c.snapshot()).toBe(before);
}, 10_000);
it('T6-O02 dirty A survives B and back, foreign review is rejected until deliberate discard', () => {
  const c = active().continuation; const epoch = c.captureEpoch();
  expect(c.updateReview(epoch, t6Review())).toBe(true); const held = c.snapshot().review;
  expect(c.selectAccount(epoch, 'b')).toBe(true); expect(c.updateReview(epoch, t6Review('b'))).toBe(false);
  expect(c.snapshot().review).toBe(held); expect(c.selectAccount(epoch, 'a')).toBe(true); expect(c.snapshot().review).toBe(held);
  expect(c.discardReview(epoch)).toBe(true); expect(c.snapshot().review.personId).toBeNull();
  expect(c.selectAccount(epoch, 'b')).toBe(true); expect(c.updateReview(epoch, t6Review('b'))).toBe(true);
}, 10_000);
it('T6-O03 pending request is recursively immutable even with shallow-frozen caller input and double submit', () => {
  const c = active().continuation; const supplied = t6Request(); Object.freeze(supplied);
  const token = t6Begin(c, supplied); const held = c.snapshot(); const retained = held.link!.request;
  expect(retained).toEqual(t6Request());
  for (const part of [held.link, retained, retained.link, retained.link.evidenceIds, retained.link.authorityEvidenceIds, retained.sourceQuotes, retained.sourceQuotes[0]]) expect(Object.isFrozen(part)).toBe(true);
  supplied.link.role = 'Changed'; supplied.link.evidenceIds.push('wrong'); supplied.sourceQuotes[0].quote = 'Changed';
  expect(retained).toEqual(t6Request()); expect(c.snapshot()).toBe(held);
  expect(c.beginLink(c.captureEpoch(), retained)).toBeNull(); expect(c.beginLink(c.captureEpoch(), t6Request('a', '2'))).toBeNull();
  expect(c.updateReview(c.captureEpoch(), t6Review())).toBe(false); expect(c.discardReview(c.captureEpoch())).toBe(false);
  expect(c.settleLink(token, { outcome: 'known', receipt: { accountId: 'a', version: 2, duplicate: false } })).toBe(true);
}, 10_000);
it('T6-O04 unknown admits only retained exact replay, old token cannot settle replay, known permits new intent', () => {
  const c = active().continuation; const first = t6Begin(c); const original = c.snapshot().link!.request;
  expect(c.settleLink(first, { outcome: 'unknown' })).toBe(true);
  expect(c.discardReview(c.captureEpoch())).toBe(false); expect(c.beginLink(c.captureEpoch(), t6Request('a', '2'))).toBeNull();
  const replay = t6Begin(c, original); expect(c.snapshot().link!.request).toBe(original); const pending = c.snapshot();
  expect(c.settleLink(first, { outcome: 'known', receipt: { accountId: 'a', version: 2, duplicate: false } })).toBe(false); expect(c.snapshot()).toBe(pending);
  expect(c.settleLink(replay, { outcome: 'known', receipt: { accountId: 'a', version: 2, duplicate: true } })).toBe(true);
  expect(c.updateReview(c.captureEpoch(), t6Review())).toBe(true); expect(c.beginLink(c.captureEpoch(), t6Request('a', '2'))).not.toBeNull();
}, 10_000);
it.each([{ accountId: 'b', version: 2, duplicate: false }, { accountId: 'a', version: 0, duplicate: false }])('T6-O05 invalid receipt %j becomes unknown instead of saved or forever pending', receipt => {
  const c = active().continuation; const token = t6Begin(c); const original = c.snapshot().link!.request;
  expect(c.settleLink(token, { outcome: 'known', receipt })).toBe(true); expect(c.snapshot().link!.outcome).toBe('unknown');
  expect(c.snapshot().link!.request).toBe(original); expect(c.beginLink(c.captureEpoch(), original)).not.toBeNull();
}, 10_000);
it('T6-O06 route selection does not fence settlement but lifetime invalidation does and keeps unknown identity', () => {
  const bundle = active(); const c = bundle.continuation; const oldEpoch = c.captureEpoch();
  const token = t6Begin(c); const original = c.snapshot().link!.request;
  expect(c.selectAccount(oldEpoch, 'b')).toBe(true);
  expect(c.settleLink(token, { outcome: 'unknown' })).toBe(true); expect(c.snapshot().selectedAccountId).toBe('b');
  expect(c.beginLink(oldEpoch, original)).toBeNull(); c.selectAccount(oldEpoch, 'a'); const replay = t6Begin(c, original);
  bundle.invalidate(); expect(c.snapshot().link!.outcome).toBe('unknown'); expect(c.snapshot().link!.request).toBe(original);
  bundle.activate(); const before = c.snapshot();
  expect(c.updateReview(oldEpoch, t6Review())).toBe(false); expect(c.discardReview(oldEpoch)).toBe(false); expect(c.beginLink(oldEpoch, original)).toBeNull();
  expect(c.settleLink(replay, { outcome: 'known', receipt: { accountId: 'a', version: 2, duplicate: false } })).toBe(false); expect(c.snapshot()).toBe(before);
}, 10_000);
it.each(['pending', 'unknown'] as const)('T6-O07 unresolved link %s blocks new research at owner, not only UI', outcome => {
  const c = active().continuation; expect(c.snapshot().research).toBeNull(); const token = t6Begin(c);
  if (outcome === 'unknown') c.settleLink(token, { outcome: 'unknown' });
  const held = c.snapshot().link; expect(c.beginResearch(c.captureEpoch(), request())).toBeNull();
  c.selectAccount(c.captureEpoch(), 'b'); expect(c.beginResearch(c.captureEpoch(), request('b'))).toBeNull(); expect(c.snapshot().link).toBe(held);
  expect(c.selectAccount(c.captureEpoch(), 'a')).toBe(true);
  const completing = outcome === 'unknown' ? t6Begin(c, held!.request) : token;
  expect(c.settleLink(completing, { outcome: 'known', receipt: { accountId: 'a', version: 2, duplicate: false } })).toBe(true);
  expect(c.snapshot().link!.outcome).toBe('known');
  expect(c.beginResearch(c.captureEpoch(), request())).not.toBeNull();
}, 10_000);
it('T6-O08 genuinely pending research cannot be erased or overlapped to dispatch a link', () => {
  const c = active().continuation; const r = request(); const execution = mustBegin(c, r); const before = c.snapshot().research;
  expect(c.beginLink(c.captureEpoch(), t6Request())).toBeNull(); expect(c.snapshot().research).toBe(before);
  c.settleResearch(execution, { outcome: 'known', status: status(r, 'completed') }); expect(c.beginLink(c.captureEpoch(), t6Request())).not.toBeNull();
}, 10_000);
function T6Observe({ captures, handlers, invoke }: { captures: FirstUseContinuation[]; handlers: Array<() => void>; invoke: (r: LinkCompanyPersonRequest) => void }) {
  const c = useFirstUseContinuation(); useSyncExternalStore(c.subscribe, c.snapshot, c.snapshot); const epoch = c.captureEpoch();
  captures.push(c); const run = () => { if (!c.selectAccount(epoch, 'a')) return; const r = t6Request(); if (c.beginLink(epoch, r)) invoke(r); };
  handlers.push(run); return <button onClick={run}>Begin reviewed link</button>;
}
it('T6-O09 real intake owner A-B-A StrictMode replacement fences stale callback before API forwarding', async () => {
  const a = intakeApi(); const b = intakeApi(); const captures: FirstUseContinuation[] = []; const handlers: Array<() => void> = []; const invoke = vi.fn();
  const tree = (api: IntakeApi) => <StrictMode><LocalCompanyIntakeProvider api={api}><T6Observe captures={captures} handlers={handlers} invoke={invoke} /></LocalCompanyIntakeProvider></StrictMode>;
  const view = render(tree(a)); await waitFor(() => expect(captures.at(-1)!.isCurrent(captures.at(-1)!.captureEpoch())).toBe(true));
  const old = captures.at(-1)!; const stale = handlers.at(-1)!; fireEvent.click(screen.getByRole('button', { name: 'Begin reviewed link' })); expect(invoke).toHaveBeenCalledOnce();
  view.rerender(tree(b)); const middle = captures.at(-1)!; view.rerender(tree(a)); const fresh = captures.at(-1)!;
  expect(fresh).not.toBe(old); expect(fresh).not.toBe(middle); expect(fresh.snapshot().link).toBeNull();
  act(() => stale()); expect(invoke).toHaveBeenCalledOnce(); expect(fresh.snapshot().link).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Begin reviewed link' })); expect(invoke).toHaveBeenCalledTimes(2);
}, 10_000);

it('T6-O10 foreign owner token with identical account and request cannot settle local pending link', () => {
  const one = active().continuation; const two = active().continuation;
  const foreign = t6Begin(one); const own = t6Begin(two); const before = two.snapshot();
  expect(two.settleLink(foreign, { outcome: 'known', receipt: { accountId: 'a', version: 2, duplicate: false } })).toBe(false); expect(two.snapshot()).toBe(before);
  expect(two.settleLink(own, { outcome: 'known', receipt: { accountId: 'a', version: 2, duplicate: false } })).toBe(true);
}, 10_000);
it('T6-O11 clean review rejects wrong account and foreign epoch without publishing', () => {
  const c = active().continuation; const other = active().continuation; const before = c.snapshot();
  expect(c.updateReview(c.captureEpoch(), t6Review('b'))).toBe(false); expect(c.updateReview(other.captureEpoch(), t6Review())).toBe(false);
  expect(c.beginLink(c.captureEpoch(), t6Request('b'))).toBeNull(); expect(c.snapshot()).toBe(before);
  expect(c.updateReview(c.captureEpoch(), t6Review())).toBe(true);
}, 10_000);
