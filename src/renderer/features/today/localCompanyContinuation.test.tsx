// @vitest-environment jsdom
import { StrictMode, useSyncExternalStore } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalCompanyResearchStatus, SelectedResearch } from '../../../shared/contracts/localWorkspaceContract';
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
