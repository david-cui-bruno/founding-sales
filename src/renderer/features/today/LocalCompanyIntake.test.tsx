// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { LocalCompanyCreateRequest, LocalCompanyCreateResult, LocalCompanyInput, LocalCompanyReview } from '../../../shared/contracts/localCompanyIntakeContract';
import type { LocalWorkspaceApi, LocalWorkspaceSnapshot } from '../../../shared/contracts/localWorkspaceContract';
import { NativeDeskRoute } from './NativeDeskRoute';
import { dailyFixture, localSnapshot, nativeDeskFixture } from './nativeDesk.fixture';
import { LocalCompanyIntake, useLocalCompanyIntake, type LocalCompanyIntakeOptions } from './LocalCompanyIntake';

const review = (input: LocalCompanyInput): LocalCompanyReview => ({ scope: 'local_database', input, candidates: [], complete: true });
const saved = (request: LocalCompanyCreateRequest): LocalCompanyCreateResult => ({ status: 'saved', commandId: request.commandId, account: { id: 'company-a', name: request.name, domain: request.domain, version: 1 }, replayed: false });
const pending = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const localRead: LocalCompanyIntakeOptions['localRead'] = { pending: false, error: false, value: { scope: 'local_database', generatedAt: '2026-09-09T12:00:00.000Z', workflowMode: 'meeting_first', transitionReceipt: null, accounts: { state: 'available', snapshots: [] } } as LocalWorkspaceSnapshot };
function fixture() {
  const api = {
    reviewCompany: vi.fn<LocalWorkspaceApi['reviewCompany']>(async input => review(input)),
    createCompany: vi.fn<LocalWorkspaceApi['createCompany']>(async request => saved(request)),
    getCompanyCreateStatus: vi.fn<LocalWorkspaceApi['getCompanyCreateStatus']>(async request => ({ status: 'not_recorded', commandId: request.commandId })),
  };
  const options: LocalCompanyIntakeOptions = { api, scopeKey: 'local-accounts', available: true, localRead, onOpenAccount: vi.fn(), onRefreshLocal: vi.fn() };
  const mount = () => render(<Harness {...options} />);
  return { api, options, mount };
}
function Harness(options: LocalCompanyIntakeOptions) {
  const controller = useLocalCompanyIntake(options);
  return <LocalCompanyIntake controller={controller} />;
}
const button = (name: string) => screen.getByRole('button', { name });
function edit(name = ' Harbor Management ', domain = ' HARBOR.EXAMPLE ') {
  fireEvent.change(screen.getByRole('textbox', { name: 'Company name' }), { target: { value: name } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Company domain (optional)' }), { target: { value: domain } });
}
async function ready(name?: string, domain?: string) {
  fireEvent.click(button('Add company')); edit(name, domain); fireEvent.click(button('Review company'));
  await waitFor(() => expect((button('Create company') as HTMLButtonElement).disabled).toBe(false));
}
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('requires explicit canonical review and create without writes on mount or review', async () => {
  const f = fixture(); f.mount(); expect(f.api.reviewCompany).not.toHaveBeenCalled(); expect(f.api.createCompany).not.toHaveBeenCalled();
  await ready(); expect(f.api.reviewCompany).toHaveBeenCalledWith({ name: 'Harbor Management', domain: 'harbor.example' });
  expect(f.api.createCompany).not.toHaveBeenCalled();
  fireEvent.click(button('Create company')); await screen.findByText(/Company saved/);
  expect(f.api.createCompany).toHaveBeenCalledOnce(); expect(f.api.createCompany.mock.calls[0][0]).toEqual({ name: 'Harbor Management', domain: 'harbor.example', commandId: expect.stringMatching(/^[a-f\d-]{36}$/) });
  expect(f.options.onOpenAccount).toHaveBeenCalledWith('company-a'); expect(f.options.onRefreshLocal).toHaveBeenCalledOnce();
});
it('accepts a missing domain without inventing one', async () => {
  const f = fixture(); f.mount(); await ready('No Domain', ''); fireEvent.click(button('Create company'));
  await screen.findByText(/Company saved/); expect(f.api.createCompany.mock.calls[0][0].domain).toBeNull();
});
it.each([[' ', ''], ['Company', 'https://harbor.example/path'], ['Company', 'not a hostname']])('rejects invalid input %j %j without a read or write', (name, domain) => {
  const f = fixture(); f.mount(); fireEvent.click(button('Add company')); edit(name, domain); fireEvent.click(button('Review company'));
  expect(screen.getByRole('alert')).toBeTruthy(); expect(f.api.reviewCompany).not.toHaveBeenCalled(); expect(f.api.createCompany).not.toHaveBeenCalled();
});
it('invalidates reviewed permission immediately on identity edits', async () => {
  const f = fixture(); f.mount(); await ready(); edit('Changed Company');
  expect((button('Create company') as HTMLButtonElement).disabled).toBe(true); fireEvent.click(button('Create company')); expect(f.api.createCompany).not.toHaveBeenCalled();
});
it('ignores an earlier review after identity changes', async () => {
  const f = fixture(); const read = pending<LocalCompanyReview>(); f.api.reviewCompany.mockReturnValueOnce(read.promise); f.mount();
  fireEvent.click(button('Add company')); edit(); fireEvent.click(button('Review company')); edit('Different Company');
  await act(async () => read.resolve(review({ name: 'Harbor Management', domain: 'harbor.example' })));
  expect((button('Create company') as HTMLButtonElement).disabled).toBe(true); expect(screen.queryByText(/No matching companies/)).toBeNull();
});
it('keeps real collision candidates visible and opens their identity without mutation', async () => {
  const f = fixture(); f.api.reviewCompany.mockImplementation(async input => ({ ...review(input), candidates: [{ account: { id: 'existing-company', name: 'Original Harbor', domain: input.domain, version: 3 }, signals: ['same_domain'] }] }));
  f.mount(); fireEvent.click(button('Add company')); edit(); fireEvent.click(button('Review company'));
  await screen.findByText('Original Harbor'); expect(screen.getByText('Same company domain')).toBeTruthy();
  expect((button('Create company') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button('Open existing company')); expect(f.options.onOpenAccount).toHaveBeenCalledWith('existing-company');
  expect(f.api.createCompany).not.toHaveBeenCalled(); expect(f.api.getCompanyCreateStatus).not.toHaveBeenCalled();
});
it('holds incomplete review even with no visible candidates', async () => {
  const f = fixture(); f.api.reviewCompany.mockImplementation(async input => ({ ...review(input), complete: false })); f.mount();
  fireEvent.click(button('Add company')); edit(); fireEvent.click(button('Review company')); await screen.findByText(/Review is incomplete/);
  expect((button('Create company') as HTMLButtonElement).disabled).toBe(true);
});
it.each(['wrong-input', 'malformed', 'unavailable'])('never treats %s review as an empty catalog', async kind => {
  const f = fixture();
  if (kind === 'unavailable') f.api.reviewCompany.mockRejectedValue(new Error('private sqlite failure'));
  else f.api.reviewCompany.mockImplementation(async input => kind === 'wrong-input' ? review({ ...input, name: 'Another Company' }) : ({ ...review(input), scope: 'not_local' } as unknown as LocalCompanyReview));
  f.mount(); fireEvent.click(button('Add company')); edit(); fireEvent.click(button('Review company')); await screen.findByRole('alert');
  expect((button('Create company') as HTMLButtonElement).disabled).toBe(true); expect(screen.queryByText(/private sqlite/)).toBeNull();
});
it('locks duplicate submits and identity while save is pending', async () => {
  const f = fixture(); const save = pending<LocalCompanyCreateResult>(); f.api.createCompany.mockReturnValue(save.promise); f.mount(); await ready();
  fireEvent.click(button('Create company')); fireEvent.click(button('Create company'));
  expect(f.api.createCompany).toHaveBeenCalledOnce(); expect((screen.getByLabelText('Company name') as HTMLInputElement).disabled).toBe(true);
  await act(async () => save.resolve(saved(f.api.createCompany.mock.calls[0][0]))); await screen.findByText(/Company saved/);
});
it('retains exact unknown request through status not_recorded and explicit retry', async () => {
  const f = fixture(); f.api.createCompany.mockRejectedValueOnce(new Error('private lost response')); f.mount(); await ready();
  fireEvent.click(button('Create company')); await screen.findByText(/Save outcome unknown/); const request = { ...f.api.createCompany.mock.calls[0][0] };
  expect(screen.queryByText(/private lost/)).toBeNull(); fireEvent.click(button('Check save status')); await screen.findByText(/not recorded/);
  expect(f.api.getCompanyCreateStatus).toHaveBeenCalledWith(request); expect(f.api.createCompany).toHaveBeenCalledOnce();
  expect((screen.getByLabelText('Company name') as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(button('Retry create')); await screen.findByText(/Company saved/); expect(f.api.createCompany.mock.calls[1][0]).toEqual(request);
});
it('recovers saved status without issuing another create', async () => {
  const f = fixture(); f.api.createCompany.mockRejectedValueOnce(new Error('lost'));
  f.api.getCompanyCreateStatus.mockImplementation(async request => ({ status: 'saved', commandId: request.commandId, account: { id: 'original-id', name: request.name, domain: request.domain, version: 1 } }));
  f.mount(); await ready(); fireEvent.click(button('Create company')); await screen.findByText(/Save outcome unknown/);
  fireEvent.click(button('Check save status')); await screen.findByText(/Company saved/); expect(f.options.onOpenAccount).toHaveBeenCalledWith('original-id'); expect(f.api.createCompany).toHaveBeenCalledOnce();
});
it.each(['command', 'account', 'version', 'shape'])('treats mismatched %s save receipt as unknown', async mismatch => {
  const f = fixture(); f.api.createCompany.mockImplementation(async request => {
    const result = saved(request); if (result.status !== 'saved') throw new Error('fixture');
    if (mismatch === 'command') result.commandId = '10000000-0000-4000-8000-000000000099';
    if (mismatch === 'account') result.account.name = 'Different Company';
    if (mismatch === 'version') result.account.version = 2;
    return mismatch === 'shape' ? { ...result, extra: true } : result;
  });
  f.mount(); await ready(); fireEvent.click(button('Create company')); await screen.findByText(/Save outcome unknown/); expect(f.options.onOpenAccount).not.toHaveBeenCalled();
});
it('renders atomic needs_review without creation success and permits explicit revised review', async () => {
  const f = fixture(); f.api.createCompany.mockImplementationOnce(async request => ({ status: 'needs_review', commandId: request.commandId, review: { ...review(request), input: { name: request.name, domain: request.domain }, candidates: [{ account: { id: 'race-winner', name: request.name, domain: request.domain, version: 1 }, signals: ['same_name', 'same_domain'] }] } }));
  f.mount(); await ready(); fireEvent.click(button('Create company')); await screen.findByRole('button', { name: 'Open existing company' });
  expect(f.options.onOpenAccount).not.toHaveBeenCalled(); expect((button('Create company') as HTMLButtonElement).disabled).toBe(true);
  edit('Actually Different', 'different.example'); fireEvent.click(button('Review company')); await waitFor(() => expect((button('Create company') as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button('Create company')); await screen.findByText(/Company saved/); expect(f.api.createCompany.mock.calls[1][0].commandId).not.toBe(f.api.createCompany.mock.calls[0][0].commandId);
});
it('holds typed command conflict without success or a replacement command', async () => {
  const f = fixture(); f.api.createCompany.mockImplementation(async request => ({ status: 'command_conflict', commandId: request.commandId })); f.mount(); await ready(); fireEvent.click(button('Create company'));
  await screen.findByText(/Command conflict/); expect(f.options.onOpenAccount).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: 'Retry create' })).toBeNull(); expect((screen.getByLabelText('Company name') as HTMLInputElement).disabled).toBe(true);
});
it('keeps accepted save separate from failing local refresh and reopens the stored ID', async () => {
  const f = fixture(); f.options.onRefreshLocal = vi.fn(() => { throw new Error('private refresh'); }); const view = f.mount(); await ready(); fireEvent.click(button('Create company'));
  await screen.findByText(/Company saved/); expect(screen.queryByText(/Save outcome unknown/)).toBeNull();
  view.rerender(<Harness {...f.options} localRead={{ ...localRead, error: true }} />);
  expect(screen.getByText(/Current local evidence could not load/)).toBeTruthy(); fireEvent.click(button('Refresh saved company'));
  expect(f.options.onOpenAccount).toHaveBeenLastCalledWith('company-a'); expect(f.api.createCompany).toHaveBeenCalledOnce();
});
it.each(['api', 'scope', 'unmount'])('ignores late saves after %s changes', async change => {
  const f = fixture(); const save = pending<LocalCompanyCreateResult>(); f.api.createCompany.mockReturnValue(save.promise); const view = f.mount(); await ready(); fireEvent.click(button('Create company'));
  const request = f.api.createCompany.mock.calls[0][0];
  if (change === 'unmount') view.unmount(); else view.rerender(<Harness {...f.options} {...(change === 'api' ? { api: fixture().api } : { scopeKey: 'other-workspace' })} />);
  await act(async () => save.resolve(saved(request))); expect(f.options.onOpenAccount).not.toHaveBeenCalled(); expect(f.options.onRefreshLocal).not.toHaveBeenCalled();
});
it('bounds unresolved transport without automatically retrying and cancels timers on unmount', async () => {
  const f = fixture(); f.api.createCompany.mockImplementation(() => new Promise(() => undefined)); const view = f.mount(); await ready(); vi.useFakeTimers(); fireEvent.click(button('Create company'));
  await act(async () => vi.advanceTimersByTimeAsync(16000)); expect(screen.getByText(/Save outcome unknown/)).toBeTruthy();
  await act(async () => vi.advanceTimersByTimeAsync(60000)); expect(f.api.createCompany).toHaveBeenCalledOnce(); view.unmount(); expect(vi.getTimerCount()).toBe(0);
});
it('does not create or review automatically under StrictMode or unavailable local scope', () => {
  const f = fixture(); render(<StrictMode><Harness {...f.options} available={false} /></StrictMode>);
  expect(screen.queryByRole('button', { name: 'Add company' })).toBeNull(); expect(f.api.reviewCompany).not.toHaveBeenCalled(); expect(f.api.createCompany).not.toHaveBeenCalled();
});
it('retains unknown identity across controlled view remount without changing surrounding editor DOM', async () => {
  const f = fixture(); f.api.createCompany.mockRejectedValueOnce(new Error('lost'));
  function Parent({ layout }: { layout: string }) { const controller = useLocalCompanyIntake(f.options); return <><textarea aria-label="Existing draft" defaultValue="unsent" /><div key={layout}><LocalCompanyIntake controller={controller} /></div></>; }
  const view = render(<Parent layout="fallback" />); const editor = screen.getByLabelText('Existing draft') as HTMLTextAreaElement;
  await ready(); fireEvent.click(button('Create company')); await screen.findByText(/Save outcome unknown/); const request = { ...f.api.createCompany.mock.calls[0][0] };
  editor.focus(); editor.setSelectionRange(2, 2); view.rerender(<Parent layout="ready" />);
  expect(screen.getByLabelText('Existing draft')).toBe(editor); expect(editor.selectionStart).toBe(2); expect(document.activeElement).toBe(editor);
  fireEvent.click(button('Retry create')); await screen.findByText(/Company saved/); expect(f.api.createCompany.mock.calls[1][0]).toEqual(request);
});

it('holds unknown identity across local availability loss and uses latest callback identities without resetting epochs', async () => {
  const f = fixture(); f.api.createCompany.mockRejectedValueOnce(new Error('lost')); const view = f.mount(); await ready(); fireEvent.click(button('Create company'));
  await screen.findByText(/Save outcome unknown/); const request = { ...f.api.createCompany.mock.calls[0][0] };
  const open = vi.fn(), refresh = vi.fn();
  view.rerender(<Harness {...f.options} available={false} localRead={{ ...localRead, error: true }} onOpenAccount={open} onRefreshLocal={refresh} />);
  expect(screen.getByText(/Any unresolved request is retained/)).toBeTruthy(); expect((button('Retry create') as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<Harness {...f.options} onOpenAccount={open} onRefreshLocal={refresh} />);
  expect(f.api.getCompanyCreateStatus).not.toHaveBeenCalled(); expect(f.api.createCompany).toHaveBeenCalledOnce();
  fireEvent.click(button('Retry create')); await screen.findByText(/Company saved/);
  expect(f.api.createCompany.mock.calls[1][0]).toEqual(request); expect(open).toHaveBeenCalledWith('company-a'); expect(refresh).toHaveBeenCalledOnce(); expect(f.options.onOpenAccount).not.toHaveBeenCalled();
});
it('does not apply late status to a replaced and restored API identity', async () => {
  const f = fixture(); f.api.createCompany.mockRejectedValue(new Error('lost'));
  const status = pending<Awaited<ReturnType<LocalWorkspaceApi['getCompanyCreateStatus']>>>(); f.api.getCompanyCreateStatus.mockReturnValue(status.promise);
  const view = f.mount(); await ready(); fireEvent.click(button('Create company')); await screen.findByText(/Save outcome unknown/); fireEvent.click(button('Check save status'));
  const request = f.api.createCompany.mock.calls[0][0]; view.rerender(<Harness {...f.options} api={fixture().api} />); view.rerender(<Harness {...f.options} />);
  await act(async () => status.resolve({ status: 'saved', commandId: request.commandId, account: { id: 'old-company', name: request.name, domain: request.domain, version: 1 } }));
  expect(f.options.onOpenAccount).not.toHaveBeenCalled(); expect(screen.queryByText(/Company saved/)).toBeNull(); expect(screen.queryByRole('textbox')).toBeNull();
});
it.each(['command', 'account', 'malformed', 'error'])('retains the command on %s status failure', async failure => {
  const f = fixture(); f.api.createCompany.mockRejectedValueOnce(new Error('lost'));
  f.api.getCompanyCreateStatus.mockImplementation(async request => {
    if (failure === 'error') throw new Error('private failure');
    if (failure === 'malformed') return { status: 'other', commandId: request.commandId } as unknown as Awaited<ReturnType<LocalWorkspaceApi['getCompanyCreateStatus']>>;
    return { status: 'saved', commandId: failure === 'command' ? '10000000-0000-4000-8000-000000000099' : request.commandId, account: { id: 'saved', name: failure === 'account' ? 'Other company' : request.name, domain: request.domain, version: 1 } };
  });
  f.mount(); await ready(); fireEvent.click(button('Create company')); await screen.findByText(/Save outcome unknown/); const request = { ...f.api.createCompany.mock.calls[0][0] };
  fireEvent.click(button('Check save status')); await screen.findByText(/Save outcome unknown/); expect(f.options.onOpenAccount).not.toHaveBeenCalled();
  fireEvent.click(button('Retry create')); await screen.findByText(/Company saved/); expect(f.api.createCompany.mock.calls[1][0]).toEqual(request);
});
it('leaves saved identity recoverable when availability is lost before its response', async () => {
  const f = fixture(); const save = pending<LocalCompanyCreateResult>(); f.api.createCompany.mockReturnValue(save.promise); const view = f.mount(); await ready(); fireEvent.click(button('Create company'));
  const request = f.api.createCompany.mock.calls[0][0]; view.rerender(<Harness {...f.options} available={false} />);
  await act(async () => save.resolve(saved(request))); expect(screen.getByText(/Company saved/)).toBeTruthy(); expect(f.options.onOpenAccount).not.toHaveBeenCalled();
  view.rerender(<Harness {...f.options} />); fireEvent.click(button('Refresh saved company')); expect(f.options.onOpenAccount).toHaveBeenCalledWith('company-a'); expect(f.api.createCompany).toHaveBeenCalledOnce();
});
it('discards a late review when the form closes and opens a fresh form', async () => {
  const f = fixture(); const read = pending<LocalCompanyReview>(); f.api.reviewCompany.mockReturnValueOnce(read.promise); f.mount(); fireEvent.click(button('Add company')); edit(); fireEvent.click(button('Review company'));
  fireEvent.click(button('Close company form')); fireEvent.click(button('Add company'));
  await act(async () => read.resolve(review({ name: 'Harbor Management', domain: 'harbor.example' })));
  expect((screen.getByLabelText('Company name') as HTMLInputElement).value).toBe(''); expect((button('Create company') as HTMLButtonElement).disabled).toBe(true);
});
it('keeps unknown creation locked against close or a fresh Add company request', async () => {
  const f = fixture(); f.api.createCompany.mockRejectedValueOnce(new Error('lost')); f.mount(); await ready(); fireEvent.click(button('Create company')); await screen.findByText(/Save outcome unknown/);
  expect((button('Close company form') as HTMLButtonElement).disabled).toBe(true); expect((button('Add company') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button('Close company form')); fireEvent.click(button('Add company')); expect(screen.getByText(/Save outcome unknown/)).toBeTruthy(); expect(f.api.createCompany).toHaveBeenCalledOnce();
});

it.each(['ready', 'daily-unavailable'] as const)('actual Accounts %s path creates then reads/selects the real local account without worker mutation', async branch => {
  const f = nativeDeskFixture(); f.setLocalSnapshot(localSnapshot());
  if (branch === 'daily-unavailable') vi.spyOn(f.api.daily, 'get').mockRejectedValue(new Error('offline'));
  const reviewApi = vi.spyOn(f.api.localWorkspace, 'reviewCompany').mockImplementation(async input => review(input));
  const createApi = vi.spyOn(f.api.localWorkspace, 'createCompany').mockImplementation(async request => {
    const result = saved(request); if (result.status !== 'saved') throw new Error('fixture');
    f.setLocalSnapshot(localSnapshot({ accounts: { state: 'available', snapshots: [{ account: result.account, claims: [], portfolio: [], routes: [], unknowns: ['Management style unknown'], conflicts: [], fingerprint: 'a'.repeat(64) }] } }));
    return result;
  });
  const openLead = vi.fn(); render(<NativeDeskRoute api={f.api} surface="accounts" onOpenLead={openLead} />);
  await screen.findByRole('button', { name: 'Add company' }); await ready(); expect(createApi).not.toHaveBeenCalled();
  fireEvent.click(button('Create company')); await screen.findByRole('heading', { name: 'Harbor Management', level: 2 });
  expect(screen.getByText('Portfolio not recorded.')).toBeTruthy(); expect(screen.getByText('Unknown: Management style unknown')).toBeTruthy();
  expect(button('Local account · Harbor Management').getAttribute('aria-current')).toBe('true');
  expect(createApi).toHaveBeenCalledOnce(); expect(reviewApi).toHaveBeenCalledOnce(); expect(openLead).not.toHaveBeenCalled();
  expect(f.calls.filter(call => !['localWorkspace.get', 'localWorkspace.getCommitments', 'daily.get', 'delegation.status'].includes(call.method))).toEqual([]);
});
it('actual local intake request survives daily fallback recovery with stable local API', async () => {
  const f = nativeDeskFixture(); const daily = pending<ReturnType<typeof dailyFixture>>(); vi.spyOn(f.api.daily, 'get').mockReturnValue(daily.promise);
  vi.spyOn(f.api.localWorkspace, 'reviewCompany').mockImplementation(async input => review(input));
  const createApi = vi.spyOn(f.api.localWorkspace, 'createCompany').mockRejectedValue(new Error('lost response'));
  render(<NativeDeskRoute api={f.api} surface="accounts" onOpenLead={vi.fn()} />); await screen.findByRole('button', { name: 'Add company' }); await ready();
  fireEvent.click(button('Create company')); await screen.findByText(/Save outcome unknown/); const request = { ...createApi.mock.calls[0][0] };
  await act(async () => daily.resolve(dailyFixture())); await screen.findByTestId('native-desk');
  expect(screen.getByText(/Save outcome unknown/)).toBeTruthy(); fireEvent.click(button('Retry create')); await screen.findByText(/Save outcome unknown/);
  expect(createApi.mock.calls[1][0]).toEqual(request);
});
it('offers read recovery for a saved company even while current local availability has failed', async () => {
  const f = fixture(); const view = f.mount(); await ready(); fireEvent.click(button('Create company')); await screen.findByText(/Company saved/);
  view.rerender(<Harness {...f.options} available={false} localRead={{ ...localRead, error: true }} />);
  expect((button('Refresh saved company') as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(button('Refresh saved company')); expect(f.options.onRefreshLocal).toHaveBeenCalledTimes(2); expect(f.api.createCompany).toHaveBeenCalledOnce();
});

it('actual Accounts opens an existing candidate by its local key without creating or changing the snapshot', async () => {
  const f = nativeDeskFixture(); const existing = { id: 'existing-local-id', name: 'Existing Harbor', domain: 'harbor.example', version: 4 };
  const original = localSnapshot({ accounts: { state: 'available', snapshots: [{ account: existing, claims: [], portfolio: [], routes: [], unknowns: ['Owner unknown'], conflicts: [], fingerprint: 'b'.repeat(64) }] } });
  f.setLocalSnapshot(original);
  vi.spyOn(f.api.localWorkspace, 'reviewCompany').mockImplementation(async input => ({ ...review(input), candidates: [{ account: existing, signals: ['same_domain'] }] }));
  const createApi = vi.spyOn(f.api.localWorkspace, 'createCompany'); const statusApi = vi.spyOn(f.api.localWorkspace, 'getCompanyCreateStatus');
  render(<NativeDeskRoute api={f.api} surface="accounts" onOpenLead={vi.fn()} />);
  await screen.findByRole('button', { name: 'Add company' }); fireEvent.click(button('Add company')); edit(); fireEvent.click(button('Review company'));
  await screen.findByRole('button', { name: 'Open existing company' }); fireEvent.click(button('Open existing company'));
  await screen.findByRole('heading', { name: 'Existing Harbor', level: 2 }); expect(button('Local account · Existing Harbor').getAttribute('aria-current')).toBe('true');
  expect(createApi).not.toHaveBeenCalled(); expect(statusApi).not.toHaveBeenCalled(); expect(await f.api.localWorkspace.get()).toEqual(original);
});
