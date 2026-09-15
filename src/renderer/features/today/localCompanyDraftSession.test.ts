import { describe, expect, it, vi } from 'vitest';
import { localCompanyDraftSession, type CompanyDraftApi } from './localCompanyDraftSession';
import type { CompanyDraftRead, CompanyDraftMutationResult, SaveCompanyDraft } from '../../../shared/contracts/localCompanyDraftContract';
const saved = (): CompanyDraftRead => ({ stale: false, reason: null, editable: true, draft: {
  kind: 'local_company_email', status: 'unsent', id: 'draft-a', accountId: 'a', revision: 1,
  recipientBinding: { routeId: 'route-a', routeVersion: 1, email: 'info@a.example', personId: null },
  accountVersionAtOpen: 1, companyLabel: 'Company A', sourceIds: ['source-a'],
  publication: { sourceId: 'source-a', url: 'https://a.example/contact', sha256: 'c'.repeat(64), fetchedAt: '2026-09-15T12:00:00.000Z', quote: 'Business email: info@a.example' },
  subject: 'Saved subject', body: 'Saved body', createdAt: '2026-09-15T12:00:00.000Z', updatedAt: '2026-09-15T12:00:00.000Z',
} });
function fixture(initial: CompanyDraftRead | null = saved()) {
  let current = structuredClone(initial);
  const receipts = new Map<string, CompanyDraftMutationResult['receipt']>();
  const get = vi.fn<CompanyDraftApi['getCompanyDraft']>(async () => structuredClone(current));
  const open = vi.fn<CompanyDraftApi['openCompanyDraft']>(async input => {
    current ??= saved();
    return { receipt: { commandId: input.commandId, accountId: 'a', draftId: current.draft.id, operation: 'open',
      appliedRevision: current.draft.revision, recipientBinding: current.draft.recipientBinding, publication: current.draft.publication }, current: structuredClone(current) };
  });
  const apply = async (input: SaveCompanyDraft): Promise<CompanyDraftMutationResult> => {
    if (!current) throw Error('Missing');
    let receipt = receipts.get(input.commandId);
    if (!receipt) {
      if (current.draft.revision !== input.expectedRevision) throw Error('Conflict');
      current = { ...current, draft: { ...current.draft, revision: current.draft.revision + 1, subject: input.subject, body: input.body } };
      receipt = { commandId: input.commandId, accountId: 'a', draftId: current.draft.id, operation: 'save', appliedRevision: current.draft.revision,
        recipientBinding: current.draft.recipientBinding, publication: current.draft.publication };
      receipts.set(input.commandId, receipt);
    }
    return { receipt, current: structuredClone(current) };
  };
  const save = vi.fn<CompanyDraftApi['saveCompanyDraft']>(apply);
  const api: CompanyDraftApi = { getCompanyDraft: get, openCompanyDraft: open, saveCompanyDraft: save };
  return { api, get, open, save, apply, replace: (value: CompanyDraftRead) => { current = value; } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
describe('company draft retained session (mock API, not persistence)', () => {
  it('is inert until read/explicit open and scopes retention by API/account/route', async () => {
    const f = fixture(null), s = localCompanyDraftSession(f.api, 'a', 'route-a');
    expect(f.get).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
    await s.read(); expect(f.open).not.toHaveBeenCalled();
    await s.open(1, 1); expect(f.open).toHaveBeenCalledTimes(1);
    s.edit('body', 'Unsaved exact\ntext  ');
    expect(localCompanyDraftSession(f.api, 'a', 'route-a')).toBe(s);
    expect(localCompanyDraftSession(f.api, 'b', 'route-a').snapshot().body).toBe('');
    expect(localCompanyDraftSession({ ...f.api }, 'a', 'route-a').snapshot().body).toBe('');
  });
  it('keeps newer keystrokes during a late save, then close flushes exact text with next CAS', async () => {
    const f = fixture(), s = localCompanyDraftSession(f.api, 'a', 'route-a'); await s.open(1, 1);
    const pending = deferred<CompanyDraftMutationResult>(); f.save.mockImplementationOnce(() => pending.promise);
    s.edit('body', 'first'); const saving = s.save(); const request = f.save.mock.calls[0][0];
    s.edit('body', 'newer\ntext  '); pending.resolve(await f.apply(request)); await saving;
    expect(s.snapshot().body).toBe('newer\ntext  '); expect(s.snapshot().current?.draft.body).toBe('first');
    expect(await s.close()).toBe(true); expect(s.snapshot().visible).toBe(false);
    expect(f.save.mock.calls[1][0]).toMatchObject({ expectedRevision: 2, body: 'newer\ntext  ' });
  });
  it('failed close retains visible text and retries the identical command after a lost committed response', async () => {
    const f = fixture(), s = localCompanyDraftSession(f.api, 'a', 'route-a'); await s.open(1, 1);
    s.edit('subject', 'Exact subject'); s.edit('body', 'Exact message\n');
    f.save.mockImplementationOnce(async request => { await f.apply(request); throw Error('private diagnostic'); });
    expect(await s.close()).toBe(false); expect(s.snapshot()).toMatchObject({ visible: true, body: 'Exact message\n', pendingSave: true });
    expect(s.snapshot().error).not.toContain('private diagnostic');
    expect(await s.close()).toBe(true); expect(f.save.mock.calls[1][0]).toEqual(f.save.mock.calls[0][0]);
    expect(s.snapshot().current?.draft.revision).toBe(2);
  });
  it('late original receipt never overwrites newer canonical text and holds local text for review', async () => {
    const f = fixture(), s = localCompanyDraftSession(f.api, 'a', 'route-a'); await s.open(1, 1);
    s.edit('body', 'first'); f.save.mockImplementationOnce(async request => { await f.apply(request); throw Error('lost'); }); await s.save();
    const later = { ...saved(), draft: { ...saved().draft, revision: 3, body: 'External newer text' } }; f.replace(later);
    expect(await s.save()).toBe(false);
    expect(s.snapshot()).toMatchObject({ body: 'first', conflict: true, pendingSave: false, current: later });
    s.useSavedText(); expect(s.snapshot().body).toBe('External newer text'); expect(s.dirty()).toBe(false);
  });
  it('preserves stale frozen recipient and permits text edits, then suppression retains unsaved text read-only', async () => {
    const stale: CompanyDraftRead = { ...saved(), stale: true, reason: 'route_changed' };
    const f = fixture(stale), s = localCompanyDraftSession(f.api, 'a', 'route-a'); await s.open(2, 2);
    expect(f.open).not.toHaveBeenCalled(); s.edit('body', 'Stale edited'); expect(await s.save()).toBe(true);
    s.edit('body', 'Unsaved copy'); f.replace({ ...s.snapshot().current!, stale: true, reason: 'suppressed', editable: false }); await s.read();
    s.edit('body', 'Forbidden change'); expect(s.snapshot().body).toBe('Unsaved copy');
    expect(await s.close()).toBe(false); expect(s.snapshot().visible).toBe(true); expect(f.save).toHaveBeenCalledTimes(1);
  });
  it('does not accept a late read over a save or another account and rejects malformed reply bindings', async () => {
    const f = fixture(), s = localCompanyDraftSession(f.api, 'a', 'route-a'); await s.open(1, 1);
    const pending = deferred<CompanyDraftRead | null>(); f.get.mockImplementationOnce(() => pending.promise); const reading = s.read();
    s.edit('body', 'New saved'); await s.save(); pending.resolve(saved()); await reading;
    expect(s.snapshot().current?.draft.body).toBe('New saved');
    f.replace({ ...saved(), draft: { ...saved().draft, accountId: 'b', body: 'Other account secret' } }); await s.read();
    expect(s.snapshot().body).toBe('New saved'); expect(s.snapshot().checked).toBe(false);
  });
  it('keeps the exact open command after unknown outcome and never opens on a failed read', async () => {
    const f = fixture(null), s = localCompanyDraftSession(f.api, 'a', 'route-a');
    f.get.mockRejectedValueOnce(Error('locked')); expect(await s.open(1, 1)).toBe(false); expect(f.open).not.toHaveBeenCalled();
    f.open.mockRejectedValueOnce(Error('lost')); expect(await s.open(1, 1)).toBe(false);
    expect(await s.open(2, 2)).toBe(true); expect(f.open.mock.calls[1][0]).toEqual(f.open.mock.calls[0][0]);
  });
  it('retries a synchronous transport failure without getting stuck busy', async () => {
    const f = fixture(), s = localCompanyDraftSession(f.api, 'a', 'route-a'); await s.open(1, 1); s.edit('body', 'Retained');
    f.save.mockImplementationOnce(() => { throw Error('synchronous transport failure'); });
    expect(await s.save()).toBe(false); expect(s.snapshot().busy).toBe(false);
    expect(await s.save()).toBe(true); expect(f.save.mock.calls[1][0]).toEqual(f.save.mock.calls[0][0]);
  });
  it('rejects changed immutable company/source context without replacing the editor', async () => {
    const f = fixture(), s = localCompanyDraftSession(f.api, 'a', 'route-a'); await s.open(1, 1); s.edit('body', 'Retained');
    f.replace({ ...saved(), draft: { ...saved().draft, companyLabel: 'Another company label' } }); await s.read();
    expect(s.snapshot().current?.draft.companyLabel).toBe('Company A'); expect(s.snapshot().body).toBe('Retained');
    expect(s.snapshot().checked).toBe(false);
  });
  it('keeps a rejected CAS command until explicit read-backed discard, then saves only a new explicit edit', async () => {
    const f = fixture(), s = localCompanyDraftSession(f.api, 'a', 'route-a'); await s.open(1, 1);
    s.edit('body', 'Local conflict'); f.replace({ ...saved(), draft: { ...saved().draft, revision: 2, body: 'Concurrent saved text' } });
    expect(await s.save()).toBe(false); const original = f.save.mock.calls[0][0];
    s.useSavedText(); expect(s.snapshot().body).toBe('Local conflict');
    await s.read(); expect(f.save).toHaveBeenCalledTimes(1); expect(s.snapshot().body).toBe('Local conflict');
    s.useSavedText(); expect(s.snapshot().body).toBe('Concurrent saved text'); expect(s.snapshot().pendingSave).toBe(false);
    s.edit('body', 'Explicit next edit'); expect(await s.save()).toBe(true);
    expect(f.save.mock.calls[1][0].commandId).not.toBe(original.commandId); expect(f.save.mock.calls[1][0].expectedRevision).toBe(2);
  });
  it('holds invalid header controls and NUL without mutating', async () => {
    const f = fixture(), s = localCompanyDraftSession(f.api, 'a', 'route-a'); await s.open(1, 1);
    s.edit('subject', 'bad\rheader'); expect(await s.save()).toBe(false);
    s.edit('subject', 'valid'); s.edit('body', 'bad\0body'); expect(await s.close()).toBe(false);
    expect(f.save).not.toHaveBeenCalled(); expect(s.snapshot().visible).toBe(true);
  });
});

it('R3 lost committed new-version Open settles the exact retained command on retry', async () => {
  const old: CompanyDraftRead = { ...saved(), stale: true, reason: 'route_changed' };
  const f = fixture(old), session = localCompanyDraftSession(f.api, 'a', 'route-a', 'route-a:2');
  const current: CompanyDraftRead = { ...saved(), draft: { ...saved().draft, id: 'version-two', recipientBinding: { ...saved().draft.recipientBinding, routeVersion: 2 }, subject: '', body: '' } };
  f.open.mockImplementationOnce(async () => { f.replace(current); throw Error('Committed response lost'); });
  f.open.mockImplementation(async request => ({ receipt: { commandId: request.commandId, accountId: 'a', draftId: current.draft.id, operation: 'open', appliedRevision: 1,
    recipientBinding: current.draft.recipientBinding, publication: current.draft.publication }, current }));
  expect(await session.open(2, 2, true)).toBe(false); const original = f.open.mock.calls[0][0];
  expect(await session.open(2, 2, true)).toBe(true);
  expect(f.open).toHaveBeenCalledTimes(2); expect(f.open.mock.calls[1][0]).toEqual(original);
  expect(session.snapshot().error).toBeNull(); expect(session.snapshot().visible).toBe(true);
});
