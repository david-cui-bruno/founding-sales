// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalCompanyDraft } from './LocalCompanyDraft';
import { dailyFixture, nativeDeskFixture } from './nativeDesk.fixture';
import type { LocalCompanyDetail, LocalWorkspaceApi } from '../../../shared/contracts/localWorkspaceContract';
import type { CompanyDraftRead, CompanyDraftMutationResult } from '../../../shared/contracts/localCompanyDraftContract';
afterEach(cleanup);
const time = '2026-09-15T12:00:00.000Z';
function fixture(accountId = 'a', hasRoute = true) {
  const snapshot = structuredClone(dailyFixture().accounts.find(item => item.account.id === accountId)!);
  snapshot.claims = []; snapshot.portfolio = []; snapshot.routes = [];
  const source = { id: `source-${accountId}`, url: `https://${accountId}.example/contact`, fetchedAt: time,
    sha256: 'c'.repeat(64), excerpt: `Full saved source.\nBusiness email: info@${accountId}.example\nFor company business.`, permitted: true };
  const route: LocalCompanyDetail['snapshot']['routes'][number] = { id: `route-${accountId}`, accountId, version: 1, personId: null, channel: 'email' as const,
    value: `info@${accountId}.example`, purpose: 'business' as const, verification: 'published' as const, evidenceIds: [source.id] };
  if (hasRoute) snapshot.routes = [route];
  const detail: LocalCompanyDetail = { scope: 'local_database', generatedAt: time, snapshot, sources: [source], links: [] };
  let saved: CompanyDraftRead | null = null;
  const makeSaved = (): CompanyDraftRead => ({ stale: false, reason: null, editable: true, draft: {
    kind: 'local_company_email', status: 'unsent', id: `draft-${accountId}`, accountId, revision: 1,
    recipientBinding: { routeId: route.id, routeVersion: route.version, email: route.value, personId: null }, accountVersionAtOpen: snapshot.account.version,
    companyLabel: snapshot.account.name, sourceIds: [source.id], publication: { sourceId: source.id, url: source.url, sha256: source.sha256, fetchedAt: time,
      quote: `Business email: ${route.value}` }, subject: 'Saved subject', body: 'Saved message', createdAt: time, updatedAt: time,
  } });
  const get = vi.fn<LocalWorkspaceApi['getCompanyDraft']>(async () => structuredClone(saved));
  const open = vi.fn<LocalWorkspaceApi['openCompanyDraft']>(async request => {
    saved ??= makeSaved(); return { receipt: { commandId: request.commandId, accountId, draftId: saved.draft.id, operation: 'open',
      appliedRevision: saved.draft.revision, recipientBinding: saved.draft.recipientBinding, publication: saved.draft.publication }, current: structuredClone(saved) };
  });
  const save = vi.fn<LocalWorkspaceApi['saveCompanyDraft']>(async request => {
    if (!saved) throw Error('Missing');
    expect(request.expectedRevision).toBe(saved.draft.revision);
    saved = { ...saved, draft: { ...saved.draft, revision: saved.draft.revision + 1, subject: request.subject, body: request.body } };
    return { receipt: { commandId: request.commandId, accountId, draftId: saved.draft.id, operation: 'save', appliedRevision: saved.draft.revision,
      recipientBinding: saved.draft.recipientBinding, publication: saved.draft.publication }, current: structuredClone(saved) };
  });
  const admit = vi.fn<LocalWorkspaceApi['admitCompanyDraftEmail']>(async request => {
    return { commandId: request.commandId, accountId, accountVersion: request.expectedAccountVersion + 1,
      recipientBinding: makeSaved().draft.recipientBinding, publication: { ...makeSaved().draft.publication, quote: request.quote }, selection: request.selection };
  });
  const getCompany = vi.fn<LocalWorkspaceApi['getCompany']>(async () => ({ ...detail,
    snapshot: { ...detail.snapshot, account: { ...detail.snapshot.account, version: detail.snapshot.account.version + 1 }, routes: [route] } }));
  const native = nativeDeskFixture();
  const api: LocalWorkspaceApi = { ...native.api.localWorkspace, getCompanyDraft: get, openCompanyDraft: open, saveCompanyDraft: save,
    admitCompanyDraftEmail: admit, getCompany };
  return { api, detail, source, route, get, open, save, admit, getCompany, makeSaved, setSaved: (read: CompanyDraftRead) => { saved = read; }, calls: native.calls };
}
async function openPanel() { fireEvent.click(await screen.findByRole('button', { name: /^(Open|Reopen) company draft$/ })); await screen.findByRole('textbox', { name: 'Subject' }); }
function reviewSource(f: ReturnType<typeof fixture>, quote = `Business email: ${f.route.value}`) {
  fireEvent.change(screen.getByRole('combobox', { name: 'Saved source' }), { target: { value: f.source.id } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Business inbox email' }), { target: { value: f.route.value } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Exact publication quote' }), { target: { value: quote } });
  fireEvent.click(screen.getByRole('checkbox'));
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
describe('company draft composer (mock API, not persistence)', () => {
  it('requires full-source review and explicit admission followed by a separate explicit open', async () => {
    const f = fixture('a', false); render(<LocalCompanyDraft api={f.api} detail={f.detail} />);
    expect(f.get).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled(); expect(f.admit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Admit reviewed company inbox' })).toHaveProperty('disabled', true);
    reviewSource(f); expect(screen.getByText(f.source.excerpt, { normalizer: text => text })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Admit reviewed company inbox' }));
    await screen.findByRole('button', { name: 'Open company draft' });
    expect(f.admit).toHaveBeenCalledWith({ commandId: expect.any(String), accountId: 'a', expectedAccountVersion: f.detail.snapshot.account.version,
      email: f.route.value, sourceId: f.source.id, quote: `Business email: ${f.route.value}`, selection: 'published_company_business_inbox' });
    expect(f.getCompany).toHaveBeenCalledWith({ accountId: 'a' }); expect(f.open).not.toHaveBeenCalled();
    await openPanel(); expect(f.open.mock.calls[0][0].expectedAccountVersion).toBe(f.detail.snapshot.account.version + 1);
    const panel = screen.getByRole('region', { name: 'Company draft' });
    expect(within(panel).queryByRole('button', { name: /generate|send|approve/i })).toBeNull(); expect(f.calls).toEqual([]);
  });
  it.each([false, true])('keeps the receipt-selected route and holds changed source identity (changed=%s)', async changed => {
    const f = fixture('a', false);
    const next = { ...f.detail, snapshot: { ...f.detail.snapshot, account: { ...f.detail.snapshot.account, version: f.detail.snapshot.account.version + 1 },
      routes: [{ ...f.route, id: 'other-route', value: 'other@a.example' }, f.route] },
      sources: [{ ...f.source, sha256: changed ? 'd'.repeat(64) : f.source.sha256 }] };
    f.getCompany.mockResolvedValueOnce(next);
    render(<LocalCompanyDraft api={f.api} detail={f.detail} />); reviewSource(f);
    fireEvent.click(screen.getByRole('button', { name: 'Admit reviewed company inbox' }));
    if (changed) { await screen.findByRole('alert'); expect(screen.queryByRole('button', { name: 'Open company draft' })).toBeNull(); }
    else { await screen.findByRole('button', { name: 'Open company draft' }); expect(screen.getByRole('combobox', { name: 'Published business inbox' })).toHaveProperty('value', f.route.id); }
    expect(f.open).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled();
  });
  it('rejects clipped mailbox evidence and invalidates confirmation when source/account observation changes', () => {
    const f = fixture('a', false); f.source.excerpt = `Business email: sales.${f.route.value}`;
    const view = render(<LocalCompanyDraft api={f.api} detail={f.detail} />); reviewSource(f, f.route.value);
    expect(screen.getByRole('button', { name: 'Admit reviewed company inbox' })).toHaveProperty('disabled', true);
    const next = structuredClone(f.detail); next.sources[0].excerpt = `Business email: ${f.route.value}`; next.snapshot.account.version++;
    view.rerender(<LocalCompanyDraft api={f.api} detail={next} />);
    expect(screen.getByRole('checkbox')).toHaveProperty('checked', false);
    expect(screen.getByRole('textbox', { name: 'Exact publication quote' })).toHaveProperty('value', ''); expect(f.admit).not.toHaveBeenCalled();
  });
  it('retains an unknown admission command across remount and never automatically replays it', async () => {
    const f = fixture('a', false); f.admit.mockRejectedValueOnce(Error('private payload'));
    const view = render(<LocalCompanyDraft api={f.api} detail={f.detail} />); reviewSource(f);
    fireEvent.click(screen.getByRole('button', { name: 'Admit reviewed company inbox' })); await screen.findByRole('alert');
    view.unmount(); render(<LocalCompanyDraft api={f.api} detail={f.detail} />);
    expect(f.admit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry reviewed inbox admission' })); await screen.findByRole('button', { name: 'Open company draft' });
    expect(f.admit.mock.calls[1][0]).toEqual(f.admit.mock.calls[0][0]); expect(f.open).not.toHaveBeenCalled();
  });
  it('failed close keeps exact visible text across remount and API replacement clears it', async () => {
    const f = fixture(); const view = render(<LocalCompanyDraft api={f.api} detail={f.detail} />); await openPanel();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Unsaved <text>\n  ' } });
    f.save.mockRejectedValueOnce(Error('secret error')); fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.not.stringContaining('secret error'));
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty('value', 'Unsaved <text>\n  ');
    view.unmount(); const reopened = render(<LocalCompanyDraft api={f.api} detail={f.detail} />);
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty('value', 'Unsaved <text>\n  ');
    const replacement = fixture(); reopened.rerender(<LocalCompanyDraft api={replacement.api} detail={replacement.detail} />);
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull(); expect(screen.queryByText('Unsaved <text>\n  ')).toBeNull();
  });
  it('stale drafts show frozen recipient and allow edits while suppressed drafts preserve unsaved text read-only', async () => {
    const f = fixture(); f.setSaved({ ...f.makeSaved(), stale: true, reason: 'route_changed' }); f.route.version = 2; f.route.value = 'changed@a.example';
    render(<LocalCompanyDraft api={f.api} detail={f.detail} />); await openPanel();
    expect(screen.getByText('info@a.example', { exact: true })).toBeTruthy(); expect(f.open).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Copy retained' } });
    f.setSaved({ ...f.makeSaved(), draft: { ...f.makeSaved().draft, recipientBinding: { routeId: f.route.id, routeVersion: 1, email: 'info@a.example', personId: null }, publication: { ...f.makeSaved().draft.publication, quote: 'Business email: info@a.example' } }, stale: true, reason: 'suppressed', editable: false });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh draft read' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty('readOnly', true));
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty('value', 'Copy retained');
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Close' })); expect(screen.getByRole('textbox', { name: 'Message' })).toBeTruthy(); expect(f.save).not.toHaveBeenCalled();
  });
  it('late open from account A cannot replace account B or leak across a replacement API', async () => {
    const a = fixture(), b = fixture('b'), pending = deferred<CompanyDraftMutationResult>();
    a.open.mockImplementationOnce(() => pending.promise);
    const view = render(<LocalCompanyDraft api={a.api} detail={a.detail} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open company draft' })); await waitFor(() => expect(a.open).toHaveBeenCalledTimes(1));
    view.rerender(<LocalCompanyDraft api={b.api} detail={b.detail} />);
    const original = a.makeSaved(); await act(async () => pending.resolve({ receipt: { commandId: a.open.mock.calls[0][0].commandId, accountId: 'a', draftId: original.draft.id,
      operation: 'open', appliedRevision: 1, recipientBinding: original.draft.recipientBinding, publication: original.draft.publication }, current: original }));
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull(); expect(screen.queryByText('info@a.example', { exact: true })).toBeNull();
    expect(screen.getByText('info@b.example', { exact: true })).toBeTruthy(); expect(b.open).not.toHaveBeenCalled();
  });
  it('opens a new route version only explicitly, never copies text, and retains the earlier unsaved editor', async () => {
    const f = fixture(); const old: CompanyDraftRead = { ...f.makeSaved(), stale: true, reason: 'route_changed' }; f.setSaved(old);
    f.route.version = 2; f.route.value = 'new@a.example';
    const fresh: CompanyDraftRead = { ...f.makeSaved(), draft: { ...f.makeSaved().draft, id: 'new-draft-a', subject: '', body: '' } };
    f.get.mockImplementation(async request => structuredClone('draftId' in request && request.draftId === fresh.draft.id ? fresh : old));
    f.open.mockImplementation(async request => ({ receipt: { commandId: request.commandId, accountId: 'a', draftId: fresh.draft.id,
      operation: 'open', appliedRevision: 1, recipientBinding: fresh.draft.recipientBinding, publication: fresh.draft.publication }, current: fresh }));
    render(<LocalCompanyDraft api={f.api} detail={f.detail} />); await openPanel();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Earlier unsaved text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select current inbox for a new draft' }));
    expect(f.open).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Open new company draft' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty('value', ''));
    expect(f.open).toHaveBeenCalledWith({ commandId: expect.any(String), accountId: 'a', routeId: f.route.id,
      expectedRouteVersion: 2, expectedAccountVersion: f.detail.snapshot.account.version });
    expect(screen.getByText('new@a.example', { exact: true })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Return to earlier draft' }));
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty('value', 'Earlier unsaved text');
    expect(screen.getByText('info@a.example', { exact: true })).toBeTruthy(); expect(f.save).not.toHaveBeenCalled();
  });
  it('does not apply a late admission refresh to a different account', async () => {
    const a = fixture('a', false), b = fixture('b', false), pending = deferred<LocalCompanyDetail>();
    a.getCompany.mockImplementationOnce(() => pending.promise);
    const view = render(<LocalCompanyDraft api={a.api} detail={a.detail} />); reviewSource(a);
    fireEvent.click(screen.getByRole('button', { name: 'Admit reviewed company inbox' }));
    await waitFor(() => expect(a.getCompany).toHaveBeenCalledTimes(1));
    view.rerender(<LocalCompanyDraft api={a.api} detail={b.detail} />);
    await act(async () => pending.resolve({ ...a.detail, snapshot: { ...a.detail.snapshot, routes: [a.route] } }));
    expect(screen.queryByRole('button', { name: 'Open company draft' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Saved source' })).toHaveProperty('value', ''); expect(a.open).not.toHaveBeenCalled();
  });
  it('reads an existing saved draft even after its route becomes personal and never opens a new one', async () => {
    const f = fixture(); f.setSaved({ ...f.makeSaved(), stale: true, reason: 'route_changed' });
    f.detail.snapshot.routes[0] = { ...f.route, version: 2, personId: 'person-existing' };
    render(<LocalCompanyDraft api={f.api} detail={f.detail} />); await openPanel();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty('value', 'Saved message');
    expect(f.open).not.toHaveBeenCalled(); expect(f.admit).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Select current inbox for a new draft' })).toBeNull();
  });
});

it('R1 rejected stale Open requires explicit fresh-read review before a new command', async () => {
  const f = fixture(); const initialVersion = f.detail.snapshot.account.version;
  f.open.mockImplementation(async request => {
    if (request.expectedAccountVersion !== initialVersion + 1) throw Error('Stale account version');
    const current = f.makeSaved(); f.setSaved(current);
    return { receipt: { commandId: request.commandId, accountId: request.accountId, draftId: current.draft.id, operation: 'open', appliedRevision: 1,
      recipientBinding: current.draft.recipientBinding, publication: current.draft.publication }, current };
  });
  render(<LocalCompanyDraft api={f.api} detail={f.detail} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open company draft' })); await screen.findByRole('alert');
  const original = f.open.mock.calls[0][0];
  fireEvent.click(screen.getByRole('button', { name: 'Open company draft' })); await waitFor(() => expect(f.open).toHaveBeenCalledTimes(2));
  expect(f.open.mock.calls[1][0]).toEqual(original);
  fireEvent.click(await screen.findByRole('button', { name: 'Review opening again' }));
  await waitFor(() => expect(f.getCompany).toHaveBeenCalledWith({ accountId: 'a' }));
  expect(f.open).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name: 'Open company draft' }));
  await screen.findByRole('textbox', { name: 'Message' });
  expect(f.open.mock.calls[2][0]).toMatchObject({ expectedAccountVersion: initialVersion + 1, expectedRouteVersion: 1 });
  expect(f.open.mock.calls[2][0].commandId).not.toBe(original.commandId);
});
it('R2 denied tenant admission is correctable only after explicit fresh source re-review', async () => {
  const f = fixture('a', false); f.source.excerpt = `Tenants: tenant@a.example\nBusiness email: ${f.route.value}`;
  f.getCompany.mockResolvedValue(f.detail);
  const admitted = f.admit.getMockImplementation()!;
  f.admit.mockImplementation(async request => { if (request.email === 'tenant@a.example') throw Error('Tenant-only target'); return admitted(request); });
  render(<LocalCompanyDraft api={f.api} detail={f.detail} />);
  reviewSource(f, 'Tenants: tenant@a.example');
  fireEvent.change(screen.getByRole('textbox', { name: 'Business inbox email' }), { target: { value: 'tenant@a.example' } }); fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Admit reviewed company inbox' })); await screen.findByRole('alert');
  const original = f.admit.mock.calls[0][0];
  fireEvent.click(await screen.findByRole('button', { name: 'Review inbox selection again' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Business inbox email' }).closest('fieldset')).toHaveProperty('disabled', false));
  expect(f.admit).toHaveBeenCalledTimes(1); expect(f.open).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Business inbox email' }), { target: { value: f.route.value } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Exact publication quote' }), { target: { value: `Business email: ${f.route.value}` } }); fireEvent.click(screen.getByRole('checkbox'));
  f.getCompany.mockResolvedValue({ ...f.detail, snapshot: { ...f.detail.snapshot, account: { ...f.detail.snapshot.account, version: f.detail.snapshot.account.version + 1 }, routes: [f.route] } });
  fireEvent.click(screen.getByRole('button', { name: 'Admit reviewed company inbox' })); await screen.findByRole('button', { name: 'Open company draft' });
  expect(f.admit.mock.calls[1][0].commandId).not.toBe(original.commandId); expect(f.admit.mock.calls[1][0].email).toBe(f.route.value); expect(f.open).not.toHaveBeenCalled();
});
it.each([false, true])('R4 version-two unsaved text remains reachable after later route change and remount (personal=%s)', async personal => {
  const f = fixture(); const old: CompanyDraftRead = { ...f.makeSaved(), stale: true, reason: 'route_changed' }; f.setSaved(old);
  f.route.version = 2; f.route.value = 'second@a.example';
  const second: CompanyDraftRead = { ...f.makeSaved(), draft: { ...f.makeSaved().draft, id: 'second-draft', subject: '', body: '' } };
  f.get.mockImplementation(async request => structuredClone('draftId' in request && request.draftId === second.draft.id ? second : old));
  f.open.mockImplementation(async request => ({ receipt: { commandId: request.commandId, accountId: 'a', draftId: second.draft.id, operation: 'open', appliedRevision: 1,
    recipientBinding: second.draft.recipientBinding, publication: second.draft.publication }, current: second }));
  const view = render(<LocalCompanyDraft api={f.api} detail={f.detail} />); await openPanel();
  fireEvent.click(screen.getByRole('button', { name: 'Select current inbox for a new draft' })); fireEvent.click(await screen.findByRole('button', { name: 'Open new company draft' }));
  await screen.findByRole('textbox', { name: 'Message' }); fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Version two unsaved\nexact  ' } });
  const next = structuredClone(f.detail); next.snapshot.routes[0] = { ...f.route, version: 3, value: 'third@a.example', personId: personal ? 'person-existing' : null };
  view.rerender(<LocalCompanyDraft api={f.api} detail={next} />);
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty('value', 'Version two unsaved\nexact  '));
  view.unmount(); render(<LocalCompanyDraft api={f.api} detail={next} />);
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty('value', 'Version two unsaved\nexact  '));
  expect(screen.getByText('second@a.example', { exact: true })).toBeTruthy(); expect(f.open).toHaveBeenCalledTimes(1); expect(f.save).not.toHaveBeenCalled();
  if (!personal) {
    fireEvent.click(screen.getByRole('button', { name: 'Select current inbox for a new draft' })); await screen.findByRole('button', { name: 'Open new company draft' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Retained company draft' }), { target: { value: `${f.route.id}:2` } });
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty('value', 'Version two unsaved\nexact  ');
    expect(screen.getByText('second@a.example', { exact: true })).toBeTruthy(); expect(f.open).toHaveBeenCalledTimes(1);
  }
});

it.each(['failed', 'wrong-account', 'wrong-route', 'superseded'])('Open re-review holds original request after %s read', async failure => {
  const f = fixture(); f.open.mockRejectedValue(Error('Stale'));
  const view = render(<LocalCompanyDraft api={f.api} detail={f.detail} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open company draft' })); await screen.findByRole('alert'); const original = f.open.mock.calls[0][0];
  const pending = deferred<LocalCompanyDetail>();
  if (failure === 'failed') f.getCompany.mockRejectedValueOnce(Error('Unavailable'));
  if (failure === 'wrong-account') f.getCompany.mockResolvedValueOnce(fixture('b').detail);
  if (failure === 'wrong-route') f.getCompany.mockResolvedValueOnce({ ...f.detail, snapshot: { ...f.detail.snapshot, routes: [{ ...f.route, id: 'other-route' }] } });
  if (failure === 'superseded') f.getCompany.mockImplementationOnce(() => pending.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Review opening again' }));
  if (failure === 'superseded') { await waitFor(() => expect(f.getCompany).toHaveBeenCalledTimes(1)); view.unmount(); render(<LocalCompanyDraft api={f.api} detail={f.detail} />); await act(async () => pending.resolve(f.detail)); }
  await waitFor(() => expect(screen.getByRole('button', { name: 'Review opening again' })).toHaveProperty('disabled', false));
  expect(f.open).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Open company draft' })); await waitFor(() => expect(f.open).toHaveBeenCalledTimes(2));
  expect(f.open.mock.calls[1][0]).toEqual(original);
});
it('Open cannot be replaced while its original promise is in flight across remount', async () => {
  const f = fixture(), pending = deferred<CompanyDraftMutationResult>(); f.open.mockImplementationOnce(() => pending.promise);
  const view = render(<LocalCompanyDraft api={f.api} detail={f.detail} />); fireEvent.click(screen.getByRole('button', { name: 'Open company draft' }));
  await waitFor(() => expect(f.open).toHaveBeenCalledTimes(1)); const original = f.open.mock.calls[0][0];
  view.unmount(); render(<LocalCompanyDraft api={f.api} detail={f.detail} />);
  expect(screen.getByRole('button', { name: 'Review opening again' })).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: 'Review opening again' })); expect(f.getCompany).not.toHaveBeenCalled();
  const current = f.makeSaved(); await act(async () => pending.resolve({ receipt: { commandId: original.commandId, accountId: 'a', draftId: current.draft.id,
    operation: 'open', appliedRevision: 1, recipientBinding: current.draft.recipientBinding, publication: current.draft.publication }, current }));
  expect(screen.getByRole('textbox', { name: 'Message' })).toBeTruthy(); expect(f.open).toHaveBeenCalledTimes(1);
});
it.each(['failed', 'wrong-account', 'changed-source'])('admission re-review retains the request on %s company read', async failure => {
  const f = fixture('a', false); f.admit.mockRejectedValue(Error('Denied'));
  render(<LocalCompanyDraft api={f.api} detail={f.detail} />); reviewSource(f); fireEvent.click(screen.getByRole('button', { name: 'Admit reviewed company inbox' })); await screen.findByRole('alert');
  const original = f.admit.mock.calls[0][0];
  if (failure === 'failed') f.getCompany.mockRejectedValueOnce(Error('Unavailable'));
  if (failure === 'wrong-account') f.getCompany.mockResolvedValueOnce(fixture('b', false).detail);
  if (failure === 'changed-source') f.getCompany.mockResolvedValueOnce({ ...f.detail, sources: [{ ...f.source, sha256: 'd'.repeat(64) }] });
  fireEvent.click(screen.getByRole('button', { name: 'Review inbox selection again' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Review inbox selection again' })).toHaveProperty('disabled', false));
  expect(screen.getByRole('textbox', { name: 'Business inbox email' }).closest('fieldset')).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: 'Retry reviewed inbox admission' })); await waitFor(() => expect(f.admit).toHaveBeenCalledTimes(2));
  expect(f.admit.mock.calls[1][0]).toEqual(original); expect(f.open).not.toHaveBeenCalled();
});
it('admission in-flight request survives remount and known receipt is never resubmitted', async () => {
  const f = fixture('a', false); const originalAdmit = f.admit.getMockImplementation()!;
  const pending = deferred<Awaited<ReturnType<LocalWorkspaceApi['admitCompanyDraftEmail']>>>(); f.admit.mockImplementationOnce(() => pending.promise);
  const view = render(<LocalCompanyDraft api={f.api} detail={f.detail} />); reviewSource(f); fireEvent.click(screen.getByRole('button', { name: 'Admit reviewed company inbox' }));
  await waitFor(() => expect(f.admit).toHaveBeenCalledTimes(1)); const request = f.admit.mock.calls[0][0];
  view.unmount(); render(<LocalCompanyDraft api={f.api} detail={f.detail} />);
  expect(screen.getByRole('button', { name: 'Review inbox selection again' })).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: 'Review inbox selection again' })); expect(f.getCompany).not.toHaveBeenCalled();
  await act(async () => pending.resolve(await originalAdmit(request)));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry reviewed inbox admission' })).toHaveProperty('disabled', false));
  fireEvent.click(screen.getByRole('button', { name: 'Retry reviewed inbox admission' })); await screen.findByRole('button', { name: 'Open company draft' });
  expect(f.admit).toHaveBeenCalledTimes(1); expect(f.open).not.toHaveBeenCalled();
});
it('known admission receipt remains held when refreshed source identity changes', async () => {
  const f = fixture('a', false);
  f.getCompany.mockResolvedValue({ ...f.detail, snapshot: { ...f.detail.snapshot, account: { ...f.detail.snapshot.account, version: f.detail.snapshot.account.version + 1 }, routes: [f.route] }, sources: [{ ...f.source, sha256: 'd'.repeat(64) }] });
  render(<LocalCompanyDraft api={f.api} detail={f.detail} />); reviewSource(f); fireEvent.click(screen.getByRole('button', { name: 'Admit reviewed company inbox' })); await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Review inbox selection again' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Review inbox selection again' })).toHaveProperty('disabled', false));
  expect(screen.getByRole('textbox', { name: 'Business inbox email' }).closest('fieldset')).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: 'Retry reviewed inbox admission' }));
  await waitFor(() => expect(f.getCompany).toHaveBeenCalledTimes(3)); expect(f.admit).toHaveBeenCalledTimes(1); expect(f.open).not.toHaveBeenCalled();
});

it('Open re-review discovers a committed draft without inventing a command receipt or opening again', async () => {
  const f = fixture(); f.open.mockImplementationOnce(async () => { f.setSaved(f.makeSaved()); throw Error('Committed response lost'); });
  render(<LocalCompanyDraft api={f.api} detail={f.detail} />); fireEvent.click(screen.getByRole('button', { name: 'Open company draft' })); await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Review opening again' }));
  await screen.findByRole('textbox', { name: 'Message' }); expect(screen.getByRole('alert').textContent).toMatch(/receipt remains unknown/);
  expect(f.open).toHaveBeenCalledTimes(1); expect(f.save).not.toHaveBeenCalled();
});
it('admission re-review discovers an existing saved route without resubmission', async () => {
  const f = fixture('a', false); f.admit.mockRejectedValueOnce(Error('Committed response lost'));
  render(<LocalCompanyDraft api={f.api} detail={f.detail} />); reviewSource(f); fireEvent.click(screen.getByRole('button', { name: 'Admit reviewed company inbox' })); await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Review inbox selection again' }));
  await screen.findByRole('button', { name: 'Open company draft' });
  expect(f.get).toHaveBeenCalledWith({ accountId: 'a', routeId: f.route.id }); expect(f.admit).toHaveBeenCalledTimes(1); expect(f.open).not.toHaveBeenCalled();
});
it('admission fresh re-review version survives a remount before the next explicit request', async () => {
  const f = fixture('a', false); f.admit.mockRejectedValue(Error('Denied'));
  const view = render(<LocalCompanyDraft api={f.api} detail={f.detail} />); reviewSource(f); fireEvent.click(screen.getByRole('button', { name: 'Admit reviewed company inbox' })); await screen.findByRole('alert');
  f.getCompany.mockResolvedValue({ ...f.detail, snapshot: { ...f.detail.snapshot, account: { ...f.detail.snapshot.account, version: 5 } } });
  fireEvent.click(screen.getByRole('button', { name: 'Review inbox selection again' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Business inbox email' }).closest('fieldset')).toHaveProperty('disabled', false));
  view.unmount(); render(<LocalCompanyDraft api={f.api} detail={f.detail} />); reviewSource(f);
  expect(f.admit).toHaveBeenCalledTimes(1); fireEvent.click(screen.getByRole('button', { name: 'Admit reviewed company inbox' }));
  await waitFor(() => expect(f.admit).toHaveBeenCalledTimes(2)); expect(f.admit.mock.calls[1][0].expectedAccountVersion).toBe(5);
});
it('a superseded admission re-review cannot unlock the original request', async () => {
  const f = fixture('a', false); f.admit.mockRejectedValue(Error('Denied'));
  const view = render(<LocalCompanyDraft api={f.api} detail={f.detail} />); reviewSource(f); fireEvent.click(screen.getByRole('button', { name: 'Admit reviewed company inbox' })); await screen.findByRole('alert');
  const original = f.admit.mock.calls[0][0], pending = deferred<LocalCompanyDetail>(); f.getCompany.mockImplementationOnce(() => pending.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Review inbox selection again' })); await waitFor(() => expect(f.getCompany).toHaveBeenCalledTimes(1));
  view.unmount(); render(<LocalCompanyDraft api={f.api} detail={f.detail} />); await act(async () => pending.resolve(f.detail));
  expect(screen.getByRole('textbox', { name: 'Business inbox email' }).closest('fieldset')).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: 'Retry reviewed inbox admission' })); await waitFor(() => expect(f.admit).toHaveBeenCalledTimes(2));
  expect(f.admit.mock.calls[1][0]).toEqual(original);
});
