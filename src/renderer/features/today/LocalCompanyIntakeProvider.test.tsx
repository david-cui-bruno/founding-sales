// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { LocalWorkspaceApi, LocalWorkspaceSnapshot } from '../../../shared/contracts/localWorkspaceContract';
import type { LocalCompanyCreateRequest, LocalCompanyCreateResult, LocalCompanyCreateStatus, LocalCompanyInput, LocalCompanyReview } from '../../../shared/contracts/localCompanyIntakeContract';
import { LocalCompanyIntake, useLocalCompanyIntake, type LocalCompanyIntakeController, type LocalCompanyIntakeOptions } from './LocalCompanyIntake';
import { LocalCompanyIntakeProvider } from './LocalCompanyIntakeProvider';

const localRead: LocalCompanyIntakeOptions['localRead'] = { pending: false, error: false, value: { scope: 'local_database', generatedAt: '2026-09-09T12:00:00.000Z', workflowMode: 'meeting_first', transitionReceipt: null, accounts: { state: 'available', snapshots: [] } } as LocalWorkspaceSnapshot };
const review = (input: LocalCompanyInput): LocalCompanyReview => ({ scope: 'local_database', input, candidates: [], complete: true });
function api() {
  return { reviewCompany: vi.fn<LocalWorkspaceApi['reviewCompany']>(async input => review(input)), createCompany: vi.fn<LocalWorkspaceApi['createCompany']>(() => new Promise(() => undefined)), getCompanyCreateStatus: vi.fn<LocalWorkspaceApi['getCompanyCreateStatus']>(() => new Promise(() => undefined)) };
}
function Form(options: LocalCompanyIntakeOptions) { return <LocalCompanyIntake controller={useLocalCompanyIntake(options)} />; }
function Observer(options: LocalCompanyIntakeOptions): null { useLocalCompanyIntake(options); return null; }
function edit() {
  fireEvent.change(screen.getByRole('textbox', { name: 'Company name' }), { target: { value: ' Harbor Management ' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Company domain (optional)' }), { target: { value: ' HARBOR.EXAMPLE ' } });
}
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('keeps one owner across Accounts view detach and ignores observing surfaces', async () => {
  const localApi = api();
  const callbacks = { onOpenAccount: vi.fn(), onRefreshLocal: vi.fn() };
  function Harness({ surface }: { surface: 'accounts' | 'campaigns' }) {
    const options = { api: localApi, scopeKey: `local-company:${surface}`, available: surface === 'accounts', localRead, ...callbacks };
    return <LocalCompanyIntakeProvider api={localApi}>
      {surface === 'accounts' ? <Form {...options} /> : <Observer {...options} />}
    </LocalCompanyIntakeProvider>;
  }
  const view = render(<Harness surface="accounts" />);
  fireEvent.click(screen.getByRole('button', { name: 'Add company' }));
  edit();
  view.rerender(<Harness surface="campaigns" />);
  expect(screen.queryByRole('textbox', { name: 'Company name' })).toBeNull();
  view.rerender(<Harness surface="accounts" />);
  expect(((await screen.findByRole('textbox', { name: 'Company name' })) as HTMLInputElement).value).toBe(' Harbor Management ');
  expect((screen.getByRole('textbox', { name: 'Company domain (optional)' }) as HTMLInputElement).value).toBe(' HARBOR.EXAMPLE ');
  expect(localApi.reviewCompany).not.toHaveBeenCalled();
});


it('blocks stale controllers after A unmounts, B remounts, and A tries every command', async () => {
  const localApi = api();
  localApi.createCompany.mockRejectedValueOnce(new Error('lost'));
  const callbacksA = { onOpenAccount: vi.fn(), onRefreshLocal: vi.fn() };
  const callbacksB = { onOpenAccount: vi.fn(), onRefreshLocal: vi.fn() };
  let stale: LocalCompanyIntakeController | null = null;
  function Capture({ id, callbacks }: { id: 'a' | 'b'; callbacks: typeof callbacksA }) {
    const controller = useLocalCompanyIntake({ api: localApi, scopeKey: 'local-company:accounts', available: true, localRead, ...callbacks });
    if (id === 'a') stale = controller;
    return <LocalCompanyIntake controller={controller} />;
  }
  function Harness({ id }: { id: 'a' | 'b' }) {
    return <LocalCompanyIntakeProvider api={localApi}>{id === 'a' ? <Capture key="a" id="a" callbacks={callbacksA} /> : <Capture key="b" id="b" callbacks={callbacksB} />}</LocalCompanyIntakeProvider>;
  }
  const view = render(<Harness id="a" />);
  fireEvent.click(screen.getByRole('button', { name: 'Add company' }));
  edit();
  fireEvent.click(screen.getByRole('button', { name: 'Review company' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Create company' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Create company' }));
  await screen.findByText(/Save outcome unknown/);
  view.rerender(<Harness id="b" />);
  expect((screen.getByRole('textbox', { name: 'Company name' }) as HTMLInputElement).value).toBe('Harbor Management');
  stale!.add(); stale!.edit('name', 'Stale'); void stale!.review(); void stale!.create(); void stale!.checkStatus(); void stale!.retry(); stale!.openExisting('existing'); stale!.reopenSaved(); stale!.close();
  expect(localApi.reviewCompany).toHaveBeenCalledOnce();
  expect(localApi.createCompany).toHaveBeenCalledOnce();
  expect(localApi.getCompanyCreateStatus).not.toHaveBeenCalled();
  expect(callbacksA.onOpenAccount).not.toHaveBeenCalled();
  expect(callbacksB.onOpenAccount).not.toHaveBeenCalled();
  expect((screen.getByRole('textbox', { name: 'Company name' }) as HTMLInputElement).value).toBe('Harbor Management');
});

it('borrows a matching nested owner without disposing the parent state', async () => {
  const localApi = api();
  const callbacks = { onOpenAccount: vi.fn(), onRefreshLocal: vi.fn() };
  function Harness({ nested }: { nested: boolean }) {
    const form = <Form api={localApi} scopeKey="local-company:accounts" available localRead={localRead} {...callbacks} />;
    return <LocalCompanyIntakeProvider api={localApi}>{nested ? <LocalCompanyIntakeProvider api={localApi}>{form}</LocalCompanyIntakeProvider> : form}</LocalCompanyIntakeProvider>;
  }
  const view = render(<Harness nested />);
  fireEvent.click(screen.getByRole('button', { name: 'Add company' }));
  edit();
  view.rerender(<Harness nested={false} />);
  expect(((await screen.findByRole('textbox', { name: 'Company name' })) as HTMLInputElement).value).toBe(' Harbor Management ');
});

it('performs a StrictMode actual action once and leaves observers unable to command', async () => {
  const localApi = api();
  const callbacks = { onOpenAccount: vi.fn(), onRefreshLocal: vi.fn() };
  let observer: LocalCompanyIntakeController | null = null;
  function ObserverCapture(): null { observer = useLocalCompanyIntake({ api: localApi, scopeKey: 'local-company:campaigns', available: false, localRead, ...callbacks }); return null; }
  render(<StrictMode><LocalCompanyIntakeProvider api={localApi}><Form api={localApi} scopeKey="local-company:accounts" available localRead={localRead} {...callbacks} /><ObserverCapture /></LocalCompanyIntakeProvider></StrictMode>);
  observer!.add(); void observer!.review(); void observer!.create();
  fireEvent.click(screen.getByRole('button', { name: 'Add company' }));
  edit();
  fireEvent.click(screen.getByRole('button', { name: 'Review company' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Create company' }) as HTMLButtonElement).disabled).toBe(false));
  expect(localApi.reviewCompany).toHaveBeenCalledOnce();
});


// Capture only the public controller. No owner internals or synthetic state injection.
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const receipt = (request: LocalCompanyCreateRequest): LocalCompanyCreateResult => ({ status: 'saved', commandId: request.commandId, account: { id: 'company-a', name: request.name, domain: request.domain, version: 1 }, replayed: false });
const callbacks = () => ({ onOpenAccount: vi.fn(), onRefreshLocal: vi.fn() });
function rig() {
  const localApi = api();
  const a = callbacks(); const b = callbacks();
  const captures: Record<string, LocalCompanyIntakeController> = {};
  function Capture({ id, available = true, scope = 'local-company:accounts', source = localApi, handlers = id === 'a' ? a : b }: { id: string; available?: boolean; scope?: string; source?: typeof localApi; handlers?: ReturnType<typeof callbacks> }) {
    const controller = useLocalCompanyIntake({ api: source, scopeKey: scope, available, localRead: available ? localRead : { pending: false, error: true, value: null }, ...handlers });
    captures[id] = controller;
    return <LocalCompanyIntake controller={controller} />;
  }
  function Tree({ id, available = true, source = localApi, handlers }: { id: string | null; available?: boolean; source?: typeof localApi; handlers?: ReturnType<typeof callbacks> }) {
    return <LocalCompanyIntakeProvider api={source}>{id && <Capture key={id} id={id} available={available} source={source} handlers={handlers} />}</LocalCompanyIntakeProvider>;
  }
  return { localApi, a, b, captures, Capture, Tree };
}
async function prepare(c: () => LocalCompanyIntakeController) {
  act(() => { c().add(); c().edit('name', ' Harbor Management '); c().edit('domain', ' HARBOR.EXAMPLE '); });
  await act(async () => { await c().review(); });
  expect(c().state.phase).toBe('reviewed');
}
function expectNoCallbacks(...sets: ReturnType<typeof callbacks>[]) {
  for (const set of sets) { expect(set.onOpenAccount).not.toHaveBeenCalled(); expect(set.onRefreshLocal).not.toHaveBeenCalled(); }
}

it.each(['away', 'early-remount'] as const)('retains the original 15s create deadline across %s and suppresses late saved completion', async timing => {
  vi.useFakeTimers();
  const f = rig(); const result = deferred<LocalCompanyCreateResult>();
  f.localApi.createCompany.mockReturnValueOnce(result.promise);
  const view = render(<f.Tree id="a" />);
  await prepare(() => f.captures.a);
  act(() => { void f.captures.a.create(); });
  const request = f.captures.a.state.request;
  expect(request).toEqual({ commandId: expect.stringMatching(/^[a-f\d-]{36}$/), name: 'Harbor Management', domain: 'harbor.example' });
  expect(f.captures.a.state.phase).toBe('creating');
  await act(async () => { vi.advanceTimersByTime(5_000); });
  view.rerender(<f.Tree id={null} />);
  if (timing === 'early-remount') view.rerender(<f.Tree id="b" />);
  await act(async () => { vi.advanceTimersByTime(9_999); });
  if (timing === 'early-remount') expect(f.captures.b.state.phase).toBe('creating');
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => { vi.advanceTimersByTime(1); });
  if (timing === 'away') view.rerender(<f.Tree id="b" />);
  expect(f.captures.b.state.phase).toBe('unknown');
  expect(f.captures.b.state.request).toBe(request);
  expect(f.captures.b.busy).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  expect(f.localApi.reviewCompany).toHaveBeenCalledOnce();
  expect(f.localApi.createCompany).toHaveBeenCalledOnce();
  expect(f.localApi.getCompanyCreateStatus).not.toHaveBeenCalled();
  await act(async () => { result.resolve(receipt(request!)); });
  expect(f.captures.b.state.phase).toBe('unknown');
  expect(f.captures.b.state.savedId).toBeNull();
  expect(f.captures.b.state.request).toBe(request);
  expectNoCallbacks(f.a, f.b);
});

it('checks not_recorded then explicitly retries identical bytes with same-turn fences after remount', async () => {
  const f = rig(); f.localApi.createCompany.mockRejectedValueOnce(new Error('unknown'));
  const status = deferred<LocalCompanyCreateStatus>(); const retry = deferred<LocalCompanyCreateResult>();
  f.localApi.getCompanyCreateStatus.mockReturnValueOnce(status.promise);
  f.localApi.createCompany.mockReturnValueOnce(retry.promise);
  const view = render(<f.Tree id="a" />); await prepare(() => f.captures.a);
  await act(async () => { await f.captures.a.create(); });
  const request = f.captures.a.state.request!;
  view.rerender(<f.Tree id={null} />); view.rerender(<f.Tree id="b" />);
  expect(f.captures.b.state.phase).toBe('unknown');
  act(() => { void f.captures.b.checkStatus(); void f.captures.b.checkStatus(); void f.captures.b.retry(); });
  expect(f.localApi.getCompanyCreateStatus.mock.calls).toEqual([[request]]);
  expect(f.localApi.createCompany).toHaveBeenCalledOnce();
  await act(async () => { status.resolve({ status: 'not_recorded', commandId: request.commandId }); });
  expect(f.captures.b.state.phase).toBe('unknown'); expect(f.captures.b.state.request).toBe(request);
  act(() => { f.captures.b.close(); f.captures.b.add(); f.captures.b.edit('name', 'Wrong'); });
  expect(f.captures.b.state.open).toBe(true); expect(f.captures.b.state.name).toBe(request.name);
  act(() => { void f.captures.b.retry(); void f.captures.b.retry(); void f.captures.b.checkStatus(); });
  expect(f.localApi.createCompany.mock.calls).toEqual([[request], [request]]);
  expect(f.localApi.getCompanyCreateStatus).toHaveBeenCalledOnce();
  await act(async () => { retry.resolve({ status: 'command_conflict', commandId: request.commandId }); });
  expect(f.captures.b.state.phase).toBe('conflict');
  act(() => { f.captures.b.close(); f.captures.b.add(); f.captures.b.edit('name', 'Wrong'); void f.captures.b.retry(); void f.captures.b.checkStatus(); });
  expect(f.captures.b.state.request).toBe(request); expect(f.captures.b.state.open).toBe(true);
  expect(f.captures.b.state.name).toBe(request.name); expect(f.captures.b.locked).toBe(true);
  expect(f.localApi.createCompany).toHaveBeenCalledTimes(2); expect(f.localApi.getCompanyCreateStatus).toHaveBeenCalledOnce();
  expectNoCallbacks(f.a, f.b);
});

it.each(['away', 'replacement-mounted'] as const)('stores saved ID from create while %s without transferring automatic navigation authority', async timing => {
  const f = rig(); const result = deferred<LocalCompanyCreateResult>(); f.localApi.createCompany.mockReturnValueOnce(result.promise);
  const view = render(<f.Tree id="a" />); await prepare(() => f.captures.a);
  act(() => { void f.captures.a.create(); }); const request = f.captures.a.state.request!;
  view.rerender(<f.Tree id={null} />);
  if (timing === 'replacement-mounted') view.rerender(<f.Tree id="b" />);
  await act(async () => { result.resolve(receipt(request)); });
  expectNoCallbacks(f.a, f.b);
  if (timing === 'away') view.rerender(<f.Tree id="b" />);
  expect(f.captures.b.state.phase).toBe('saved'); expect(f.captures.b.state.savedId).toBe('company-a');
  expect(f.captures.b.state.request).toBe(request); expectNoCallbacks(f.a, f.b);
  expect(f.localApi.reviewCompany).toHaveBeenCalledOnce(); expect(f.localApi.createCompany).toHaveBeenCalledOnce(); expect(f.localApi.getCompanyCreateStatus).not.toHaveBeenCalled();
  act(() => f.captures.b.reopenSaved());
  expectNoCallbacks(f.a); expect(f.b.onOpenAccount.mock.calls).toEqual([['company-a']]); expect(f.b.onRefreshLocal).toHaveBeenCalledOnce();
});

it.each(['away', 'replacement-mounted'] as const)('stores saved status while %s with explicit new-view recovery only', async timing => {
  const f = rig(); f.localApi.createCompany.mockRejectedValueOnce(new Error('unknown'));
  const status = deferred<LocalCompanyCreateStatus>(); f.localApi.getCompanyCreateStatus.mockReturnValueOnce(status.promise);
  const view = render(<f.Tree id="a" />); await prepare(() => f.captures.a);
  await act(async () => { await f.captures.a.create(); }); const request = f.captures.a.state.request!;
  act(() => { void f.captures.a.checkStatus(); }); expect(f.captures.a.state.phase).toBe('checking');
  view.rerender(<f.Tree id={null} />); if (timing === 'replacement-mounted') view.rerender(<f.Tree id="b" />);
  await act(async () => { status.resolve({ status: 'saved', commandId: request.commandId, account: { id: 'company-a', name: request.name, domain: request.domain, version: 1 } }); });
  if (timing === 'away') view.rerender(<f.Tree id="b" />);
  expect(f.captures.b.state.phase).toBe('saved'); expect(f.captures.b.state.savedId).toBe('company-a'); expectNoCallbacks(f.a, f.b);
  expect(f.localApi.createCompany).toHaveBeenCalledOnce(); expect(f.localApi.getCompanyCreateStatus.mock.calls).toEqual([[request]]);
  act(() => f.captures.b.reopenSaved()); expect(f.b.onOpenAccount.mock.calls).toEqual([['company-a']]); expect(f.b.onRefreshLocal).toHaveBeenCalledOnce(); expectNoCallbacks(f.a);
});

it('uses latest callbacks for the same live token without restarting its pending create', async () => {
  const f = rig(); const result = deferred<LocalCompanyCreateResult>(); f.localApi.createCompany.mockReturnValueOnce(result.promise);
  const view = render(<f.Tree id="a" handlers={f.a} />); await prepare(() => f.captures.a);
  act(() => { void f.captures.a.create(); }); const request = f.captures.a.state.request!;
  view.rerender(<f.Tree id="a" handlers={f.b} />);
  await act(async () => { result.resolve(receipt(request)); });
  expect(f.captures.a.state.phase).toBe('saved'); expectNoCallbacks(f.a);
  expect(f.b.onOpenAccount.mock.calls).toEqual([['company-a']]); expect(f.b.onRefreshLocal).toHaveBeenCalledOnce();
  expect(f.localApi.createCompany.mock.calls).toEqual([[request]]);
});

it('holds unavailable mutations but permits saved recovery and unlocked Close, not unresolved Close', async () => {
  const f = rig(); const result = deferred<LocalCompanyCreateResult>(); f.localApi.createCompany.mockReturnValueOnce(result.promise);
  const view = render(<f.Tree id="a" />); await prepare(() => f.captures.a);
  view.rerender(<f.Tree id="a" available={false} />);
  act(() => { void f.captures.a.review(); void f.captures.a.create(); void f.captures.a.retry(); void f.captures.a.checkStatus(); });
  expect(f.localApi.reviewCompany).toHaveBeenCalledOnce(); expect(f.localApi.createCompany).not.toHaveBeenCalled(); expect(f.localApi.getCompanyCreateStatus).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Close company form' })); expect(f.captures.a.state.open).toBe(false);
  view.rerender(<f.Tree id="a" />); await prepare(() => f.captures.a);
  act(() => { void f.captures.a.create(); }); const request = f.captures.a.state.request!;
  view.rerender(<f.Tree id="a" available={false} />);
  expect((screen.getByRole('button', { name: 'Close company form' }) as HTMLButtonElement).disabled).toBe(true);
  act(() => f.captures.a.close()); expect(f.captures.a.state.open).toBe(true);
  await act(async () => { result.resolve(receipt(request)); });
  expect(f.captures.a.state.phase).toBe('saved'); expectNoCallbacks(f.a, f.b);
  view.rerender(<f.Tree id="b" available={false} />);
  expect((screen.getByRole('button', { name: 'Refresh saved company' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh saved company' }));
  expect(f.b.onOpenAccount.mock.calls).toEqual([['company-a']]); expect(f.b.onRefreshLocal).toHaveBeenCalledOnce(); expectNoCallbacks(f.a);
  expect(f.localApi.createCompany).toHaveBeenCalledOnce(); expect(f.localApi.getCompanyCreateStatus).not.toHaveBeenCalled();
});

it('settles pending review while unbound and exposes reviewed permission without replay on return', async () => {
  const f = rig(); const result = deferred<LocalCompanyReview>(); f.localApi.reviewCompany.mockReturnValueOnce(result.promise);
  const view = render(<f.Tree id="a" />);
  act(() => { f.captures.a.add(); f.captures.a.edit('name', 'Harbor Management'); void f.captures.a.review(); });
  expect(f.captures.a.state.phase).toBe('reviewing'); view.rerender(<f.Tree id={null} />);
  await act(async () => { result.resolve(review({ name: 'Harbor Management', domain: null })); });
  view.rerender(<f.Tree id="b" />);
  expect(f.captures.b.state.phase).toBe('reviewed'); expect(f.captures.b.busy).toBe(false);
  expect(f.captures.b.state.review).toEqual(review({ name: 'Harbor Management', domain: null }));
  expect(f.localApi.reviewCompany).toHaveBeenCalledOnce(); expect(f.localApi.createCompany).not.toHaveBeenCalled(); expectNoCallbacks(f.a, f.b);
});

it('API A to B to A suppresses both disposed late results and allocates fresh actionable state', async () => {
  vi.useFakeTimers(); const f = rig(); const other = api();
  const oldA = deferred<LocalCompanyCreateResult>(); const oldB = deferred<LocalCompanyCreateResult>();
  f.localApi.createCompany.mockReturnValueOnce(oldA.promise); other.createCompany.mockReturnValueOnce(oldB.promise);
  const view = render(<f.Tree id="a" />); await prepare(() => f.captures.a);
  act(() => { void f.captures.a.create(); }); const requestA = f.captures.a.state.request!; expect(vi.getTimerCount()).toBe(1);
  view.rerender(<f.Tree id="b" source={other} />); expect(vi.getTimerCount()).toBe(0);
  await prepare(() => f.captures.b); act(() => { void f.captures.b.create(); }); const requestB = f.captures.b.state.request!;
  expect(vi.getTimerCount()).toBe(1); view.rerender(<f.Tree id="a" />); expect(vi.getTimerCount()).toBe(0);
  expect(f.captures.a.state.open).toBe(false); expect(f.captures.a.state.request).toBeNull(); expect(f.captures.a.busy).toBe(false);
  await act(async () => { oldA.resolve(receipt(requestA)); oldB.resolve(receipt(requestB)); });
  expect(f.captures.a.state.open).toBe(false); expect(f.captures.a.state.savedId).toBeNull(); expectNoCallbacks(f.a, f.b);
  await prepare(() => f.captures.a); expect(f.localApi.reviewCompany).toHaveBeenCalledTimes(2);
});

it('StrictMode admits one actual pending create and provider teardown clears its timer and late callbacks', async () => {
  vi.useFakeTimers(); const f = rig(); const result = deferred<LocalCompanyCreateResult>(); f.localApi.createCompany.mockReturnValueOnce(result.promise);
  const view = render(<StrictMode><f.Tree id="a" /></StrictMode>);
  expect(vi.getTimerCount()).toBe(0); expect(f.localApi.reviewCompany).not.toHaveBeenCalled();
  await prepare(() => f.captures.a);
  act(() => { void f.captures.a.create(); void f.captures.a.create(); });
  const request = f.captures.a.state.request!; expect(f.captures.a.state.phase).toBe('creating'); expect(f.captures.a.busy).toBe(true);
  expect(f.localApi.createCompany.mock.calls).toEqual([[request]]); expect(vi.getTimerCount()).toBe(1);
  view.unmount(); expect(vi.getTimerCount()).toBe(0);
  await act(async () => { result.resolve(receipt(request)); }); expectNoCallbacks(f.a, f.b); expect(vi.getTimerCount()).toBe(0);
});

it('matching nested borrower teardown preserves the ancestor pending request and original deadline', async () => {
  vi.useFakeTimers(); const f = rig();
  function Tree({ nested }: { nested: boolean }) { return <LocalCompanyIntakeProvider api={f.localApi}>{nested ? <LocalCompanyIntakeProvider api={f.localApi}><f.Capture id="a" /></LocalCompanyIntakeProvider> : <f.Capture id="b" />}</LocalCompanyIntakeProvider>; }
  const view = render(<Tree nested />); await prepare(() => f.captures.a); act(() => { void f.captures.a.create(); });
  const request = f.captures.a.state.request!;
  await act(async () => { vi.advanceTimersByTime(6_000); }); view.rerender(<Tree nested={false} />);
  expect(f.captures.b.state.phase).toBe('creating'); expect(f.captures.b.state.request).toBe(request); expect(vi.getTimerCount()).toBe(1);
  await act(async () => { vi.advanceTimersByTime(9_000); });
  expect(f.captures.b.state.phase).toBe('unknown'); expect(f.captures.b.state.request).toBe(request); expect(vi.getTimerCount()).toBe(0);
  expect(f.localApi.createCompany.mock.calls).toEqual([[request]]); expectNoCallbacks(f.a, f.b);
});

it('outer A inner B to borrowed A to B never resurrects disposed busy B or disposes pending ancestor A', async () => {
  vi.useFakeTimers(); const f = rig(); const other = api(); const oldB = deferred<LocalCompanyCreateResult>(); other.createCompany.mockReturnValueOnce(oldB.promise);
  function Tree({ source }: { source: typeof other }) { return <LocalCompanyIntakeProvider api={f.localApi}><f.Capture id="outer" /><LocalCompanyIntakeProvider api={source}><f.Capture id="inner" source={source} /></LocalCompanyIntakeProvider></LocalCompanyIntakeProvider>; }
  const view = render(<Tree source={other} />);
  await prepare(() => f.captures.outer); act(() => { void f.captures.outer.create(); }); const requestA = f.captures.outer.state.request!;
  await prepare(() => f.captures.inner); act(() => { void f.captures.inner.create(); }); const requestB = f.captures.inner.state.request!;
  expect(vi.getTimerCount()).toBe(2);
  view.rerender(<Tree source={f.localApi} />); expect(vi.getTimerCount()).toBe(1); expect(f.captures.inner.state.request).toBe(requestA);
  view.rerender(<Tree source={other} />);
  expect(f.captures.inner.state.open).toBe(false); expect(f.captures.inner.state.request).toBeNull(); expect(f.captures.inner.busy).toBe(false);
  await act(async () => { oldB.resolve(receipt(requestB)); }); expect(f.captures.inner.state.savedId).toBeNull();
  await prepare(() => f.captures.inner); expect(other.reviewCompany).toHaveBeenCalledTimes(2);
  await act(async () => { vi.advanceTimersByTime(15_000); });
  expect(f.captures.outer.state.phase).toBe('unknown'); expect(f.captures.outer.state.request).toBe(requestA); expect(vi.getTimerCount()).toBe(0); expectNoCallbacks(f.a, f.b);
});

it('old binding cleanup cannot remove the newer live binding and observers cannot create from reviewed state', async () => {
  const f = rig();
  function Tree({ old }: { old: boolean }) { return <LocalCompanyIntakeProvider api={f.localApi}>{old && <f.Capture key="old" id="a" />}<f.Capture key="new" id="b" /><f.Capture key="today" id="today" scope="local-company:today" available={false} /><f.Capture key="campaigns" id="campaigns" scope="local-company:campaigns" available={false} /></LocalCompanyIntakeProvider>; }
  const view = render(<Tree old />); await prepare(() => f.captures.b); const stale = f.captures.a;
  view.rerender(<Tree old={false} />);
  expect(f.captures.b.state.phase).toBe('reviewed'); expect(f.captures.b.available).toBe(true);
  act(() => { void stale.create(); void f.captures.today.create(); void f.captures.campaigns.create(); stale.close(); f.captures.today.edit('name', 'Wrong'); f.captures.campaigns.add(); });
  expect(f.localApi.createCompany).not.toHaveBeenCalled(); expect(f.captures.b.state.phase).toBe('reviewed'); expect(f.captures.b.state.name).toBe('Harbor Management'); expect(f.captures.b.state.open).toBe(true);
  act(() => { void f.captures.b.create(); }); expect(f.localApi.createCompany).toHaveBeenCalledOnce(); expect(f.captures.b.state.phase).toBe('creating');
});

it('verified needs_review settles while away and releases only that original request for explicit revised review', async () => {
  const f = rig(); const result = deferred<LocalCompanyCreateResult>(); f.localApi.createCompany.mockReturnValueOnce(result.promise);
  const view = render(<f.Tree id="a" />); await prepare(() => f.captures.a); act(() => { void f.captures.a.create(); });
  const request = f.captures.a.state.request!; view.rerender(<f.Tree id={null} />);
  await act(async () => { result.resolve({ status: 'needs_review', commandId: request.commandId, review: { ...review({ name: request.name, domain: request.domain }), complete: false } }); });
  view.rerender(<f.Tree id="b" />); expect(f.captures.b.state.phase).toBe('reviewed'); expect(f.captures.b.state.request).toBeNull(); expect(f.captures.b.locked).toBe(false);
  expect(f.captures.b.state.review?.complete).toBe(false); expect(f.localApi.createCompany).toHaveBeenCalledOnce(); expectNoCallbacks(f.a, f.b);
  act(() => { void f.captures.b.create(); }); expect(f.localApi.createCompany).toHaveBeenCalledOnce();
  act(() => { f.captures.b.edit('name', 'New Company'); f.captures.b.edit('domain', 'new.example'); });
  await act(async () => { await f.captures.b.review(); }); act(() => { void f.captures.b.create(); });
  expect(f.localApi.createCompany.mock.calls[1][0]).toEqual({ commandId: expect.any(String), name: 'New Company', domain: 'new.example' });
  expect(f.localApi.createCompany.mock.calls[1][0].commandId).not.toBe(request.commandId);
});

it('unavailable unknown view blocks status and retry despite their otherwise eligible phase', async () => {
  const f = rig(); f.localApi.createCompany.mockRejectedValueOnce(new Error('unknown'));
  const view = render(<f.Tree id="a" />); await prepare(() => f.captures.a); await act(async () => { await f.captures.a.create(); });
  const request = f.captures.a.state.request!; expect(f.captures.a.state.phase).toBe('unknown');
  view.rerender(<f.Tree id="b" available={false} />);
  act(() => { void f.captures.b.checkStatus(); void f.captures.b.retry(); f.captures.b.close(); f.captures.b.add(); f.captures.b.edit('name', 'Wrong'); });
  expect(f.captures.b.state.phase).toBe('unknown'); expect(f.captures.b.state.request).toBe(request); expect(f.captures.b.state.open).toBe(true);
  expect(f.captures.b.state.name).toBe(request.name); expect(f.localApi.createCompany).toHaveBeenCalledOnce(); expect(f.localApi.getCompanyCreateStatus).not.toHaveBeenCalled();
  view.rerender(<f.Tree id="b" />); act(() => { void f.captures.b.checkStatus(); }); expect(f.localApi.getCompanyCreateStatus.mock.calls).toEqual([[request]]);
});

const rejectedActions = (['review', 'edit', 'close', 'add', 'create', 'retry', 'checkStatus', 'openExisting', 'reopenSaved'] as const).flatMap(action =>
  (['departed', 'today', 'campaigns'] as const).map(actor => ({ action, actor })));
it.each(rejectedActions)('rejects $actor $action handler in its eligible phase while the new binding can act', async ({ action, actor }) => {
  const f = rig();
  if (action === 'openExisting') f.localApi.reviewCompany.mockImplementationOnce(async input => ({ ...review(input), candidates: [{ account: { id: 'existing', ...input, version: 1 }, signals: ['same_name', 'same_domain'] }] }));
  if (action === 'reopenSaved') f.localApi.createCompany.mockImplementationOnce(async request => receipt(request));
  if (action === 'retry' || action === 'checkStatus') f.localApi.createCompany.mockRejectedValueOnce(new Error('unknown'));
  function Tree({ id }: { id: 'a' | 'b' }) { return <LocalCompanyIntakeProvider api={f.localApi}><f.Capture key={id} id={id} /><f.Capture key="observer" id="observer" scope={`local-company:${actor === 'departed' ? 'today' : actor}`} available={false} /></LocalCompanyIntakeProvider>; }
  const view = render(<Tree id="a" />);
  if (['create', 'retry', 'checkStatus', 'openExisting', 'reopenSaved'].includes(action)) await prepare(() => f.captures.a);
  else act(() => { f.captures.a.add(); f.captures.a.edit('name', 'Harbor Management'); });
  if (action === 'reopenSaved') { await act(async () => { await f.captures.a.create(); }); expect(f.captures.a.state.phase).toBe('saved'); f.a.onOpenAccount.mockClear(); f.a.onRefreshLocal.mockClear(); }
  if (action === 'retry' || action === 'checkStatus') { await act(async () => { await f.captures.a.create(); }); expect(f.captures.a.state.phase).toBe('unknown'); }
  const stale = f.captures.a;
  view.rerender(<Tree id="b" />); const state = f.captures.b.state; const reviews = f.localApi.reviewCompany.mock.calls.length;
  const creates = f.localApi.createCompany.mock.calls.length; const statuses = f.localApi.getCompanyCreateStatus.mock.calls.length;
  const invoke = (c: LocalCompanyIntakeController) => {
    if (action === 'edit') c.edit('name', 'Updated');
    else if (action === 'openExisting') c.openExisting('existing');
    else if (action === 'review' || action === 'create' || action === 'retry' || action === 'checkStatus') void c[action]();
    else c[action]();
  };
  await act(async () => { invoke(actor === 'departed' ? stale : f.captures.observer); });
  expect(f.captures.b.state).toBe(state); expect(f.localApi.reviewCompany).toHaveBeenCalledTimes(reviews);
  expect(f.localApi.createCompany).toHaveBeenCalledTimes(creates); expect(f.localApi.getCompanyCreateStatus).toHaveBeenCalledTimes(statuses); expectNoCallbacks(f.a, f.b);
  await act(async () => { invoke(f.captures.b); });
  if (action === 'review') { expect(f.localApi.reviewCompany).toHaveBeenCalledTimes(reviews + 1); expect(f.captures.b.state.phase).toBe('reviewed'); }
  else if (action === 'openExisting' || action === 'reopenSaved') { expect(f.b.onOpenAccount.mock.calls).toEqual([[action === 'openExisting' ? 'existing' : 'company-a']]); expect(f.b.onRefreshLocal).toHaveBeenCalledOnce(); }
  else if (action === 'create' || action === 'retry') { expect(f.localApi.createCompany).toHaveBeenCalledTimes(creates + 1); expect(f.captures.b.state.phase).toBe('creating'); }
  else if (action === 'checkStatus') { expect(f.localApi.getCompanyCreateStatus).toHaveBeenCalledTimes(statuses + 1); expect(f.captures.b.state.phase).toBe('checking'); }
  else if (action === 'close') expect(f.captures.b.state.open).toBe(false);
  else expect(f.captures.b.state.name).toBe(action === 'edit' ? 'Updated' : '');
});

it.each(['status', 'retry'] as const)('late timed-out create cannot overwrite a newer explicit %s operation on the same retained request', async kind => {
  vi.useFakeTimers(); const f = rig(); const old = deferred<LocalCompanyCreateResult>(); const newer = deferred<LocalCompanyCreateResult>(); const status = deferred<LocalCompanyCreateStatus>();
  f.localApi.createCompany.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise); f.localApi.getCompanyCreateStatus.mockReturnValueOnce(status.promise);
  const view = render(<f.Tree id="a" />); await prepare(() => f.captures.a); act(() => { void f.captures.a.create(); }); const request = f.captures.a.state.request!;
  view.rerender(<f.Tree id={null} />); await act(async () => { vi.advanceTimersByTime(15_000); }); view.rerender(<f.Tree id="b" />);
  expect(f.captures.b.state.phase).toBe('unknown');
  act(() => { if (kind === 'status') void f.captures.b.checkStatus(); else void f.captures.b.retry(); });
  expect(f.captures.b.state.phase).toBe(kind === 'status' ? 'checking' : 'creating'); expect(vi.getTimerCount()).toBe(1);
  await act(async () => { old.resolve(receipt(request)); });
  expect(f.captures.b.state.phase).toBe(kind === 'status' ? 'checking' : 'creating'); expect(f.captures.b.state.savedId).toBeNull(); expect(f.captures.b.state.request).toBe(request); expectNoCallbacks(f.a, f.b);
  await act(async () => {
    if (kind === 'status') status.resolve({ status: 'not_recorded', commandId: request.commandId });
    else newer.resolve({ status: 'command_conflict', commandId: request.commandId });
  });
  expect(f.captures.b.state.phase).toBe(kind === 'status' ? 'unknown' : 'conflict'); expect(f.captures.b.state.request).toBe(request); expect(vi.getTimerCount()).toBe(0);
  expect(f.localApi.createCompany.mock.calls).toEqual(kind === 'status' ? [[request]] : [[request], [request]]);
  expect(f.localApi.getCompanyCreateStatus.mock.calls).toEqual(kind === 'status' ? [[request]] : []); expectNoCallbacks(f.a, f.b);
});

it('late needs_review from a disposed API cannot release the replacement owners pending request', async () => {
  const f = rig(); const other = api(); const old = deferred<LocalCompanyCreateResult>(); const current = deferred<LocalCompanyCreateResult>();
  f.localApi.createCompany.mockReturnValueOnce(old.promise); other.createCompany.mockReturnValueOnce(current.promise);
  const view = render(<f.Tree id="a" />); await prepare(() => f.captures.a); act(() => { void f.captures.a.create(); }); const first = f.captures.a.state.request!;
  view.rerender(<f.Tree id="b" source={other} />); await prepare(() => f.captures.b); act(() => { void f.captures.b.create(); }); const second = f.captures.b.state.request!;
  expect(second.commandId).not.toBe(first.commandId);
  await act(async () => { old.resolve({ status: 'needs_review', commandId: first.commandId, review: { ...review({ name: first.name, domain: first.domain }), complete: false } }); });
  expect(f.captures.b.state.phase).toBe('creating'); expect(f.captures.b.state.request).toBe(second); expect(f.captures.b.locked).toBe(true); expect(f.captures.b.busy).toBe(true);
  await act(async () => { current.resolve({ status: 'needs_review', commandId: second.commandId, review: { ...review({ name: second.name, domain: second.domain }), complete: false } }); });
  expect(f.captures.b.state.phase).toBe('reviewed'); expect(f.captures.b.state.request).toBeNull(); expect(f.captures.b.locked).toBe(false); expect(f.captures.b.busy).toBe(false); expectNoCallbacks(f.a, f.b);
});

it('rejects captured old create after the same hook returns Accounts to Today to Accounts while latest create remains eligible', async () => {
  const f = rig();
  function Tree({ scope }: { scope: string }) { return <LocalCompanyIntakeProvider api={f.localApi}><f.Capture id="a" scope={scope} /></LocalCompanyIntakeProvider>; }
  const view = render(<Tree scope="local-company:accounts" />);
  await prepare(() => f.captures.a);
  const oldCreate = f.captures.a.create;
  const reviewed = f.captures.a.state.review;
  view.rerender(<Tree scope="local-company:today" />);
  expect(f.captures.a.available).toBe(false);
  view.rerender(<Tree scope="local-company:accounts" />);
  expect(f.captures.a.state.phase).toBe('reviewed');
  expect(f.captures.a.state.review).toBe(reviewed);
  expect(f.captures.a.available).toBe(true);
  const latestCreate = f.captures.a.create;
  act(() => { void oldCreate(); });
  expect(f.localApi.createCompany).not.toHaveBeenCalled();
  expect(f.captures.a.state.phase).toBe('reviewed');
  expect(f.captures.a.state.request).toBeNull();
  act(() => { void latestCreate(); });
  expect(f.localApi.createCompany).toHaveBeenCalledOnce();
  expect(f.captures.a.state.phase).toBe('creating');
  expect(f.localApi.createCompany.mock.calls[0][0]).toEqual({ commandId: expect.stringMatching(/^[a-f\d-]{36}$/), name: 'Harbor Management', domain: 'harbor.example' });
  expect(f.localApi.reviewCompany).toHaveBeenCalledOnce();
  expectNoCallbacks(f.a, f.b);
});

it('rejects captured old edit after the same hook returns Accounts to Today to Accounts while latest edit remains eligible', async () => {
  const f = rig();
  function Tree({ scope }: { scope: string }) { return <LocalCompanyIntakeProvider api={f.localApi}><f.Capture id="a" scope={scope} /></LocalCompanyIntakeProvider>; }
  const view = render(<Tree scope="local-company:accounts" />);
  await prepare(() => f.captures.a);
  const oldEdit = f.captures.a.edit;
  const reviewed = f.captures.a.state.review;
  view.rerender(<Tree scope="local-company:today" />);
  view.rerender(<Tree scope="local-company:accounts" />);
  expect(f.captures.a.state.phase).toBe('reviewed');
  expect(f.captures.a.available).toBe(true);
  const latestEdit = f.captures.a.edit;
  act(() => oldEdit('name', 'Stale company'));
  expect(f.captures.a.state.name).toBe('Harbor Management');
  expect(f.captures.a.state.review).toBe(reviewed);
  expect(f.captures.a.state.phase).toBe('reviewed');
  act(() => latestEdit('name', 'Current company'));
  expect(f.captures.a.state.name).toBe('Current company');
  expect(f.captures.a.state.phase).toBe('editing');
  expect(f.captures.a.state.review).toBeNull();
  expect(f.localApi.reviewCompany).toHaveBeenCalledOnce();
  expect(f.localApi.createCompany).not.toHaveBeenCalled();
  expect(f.localApi.getCompanyCreateStatus).not.toHaveBeenCalled();
  expectNoCallbacks(f.a, f.b);
});
