// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CalliePreloadApi } from '../../../shared/preload';
import type { LeadDetail } from '../../../shared/contracts/leadDetailContract';
import type { LeadRow, LeadsListResponse } from '../../../shared/contracts/leadsContract';
import type { LocalCompanyDetail, LocalWorkspaceApi } from '../../../shared/contracts/localWorkspaceContract';
import type { AccountEvidenceReceipt } from '../../../shared/contracts/accountContract';
import { dailyFixture } from './nativeDesk.fixture';
import { createLocalCompanyContinuation } from './localCompanyContinuation';
import { LocalCompanyContactLink } from './LocalCompanyContactLink';

// Synthetic API projections only. These tests cannot prove main storage or identity truth.
type PanelApi = Pick<CalliePreloadApi, 'leads' | 'leadDetail'> & { localWorkspace: Pick<LocalWorkspaceApi, 'getCompany' | 'linkCompanyPerson'> };
const quote = 'Avery manages company A. <b>Not HTML</b>';
const at = '2026-09-10T12:00:00.000Z';
const initialQuery: Parameters<CalliePreloadApi['leads']['list']>[0] = { query: '', stages: [], priorities: [], sort: 'person_name', cursor: null, limit: 50 };
function company(accountId = 'a'): LocalCompanyDetail {
  const snapshot = structuredClone(dailyFixture().accounts.find(item => item.account.id === accountId)!);
  snapshot.claims = []; snapshot.routes = []; snapshot.portfolio = [];
  return { scope: 'local_database', generatedAt: at, snapshot, sources: [{ id: `source-${accountId}`, url: `https://${accountId}.example/team`, fetchedAt: at, sha256: '6'.repeat(64), permitted: true, excerpt: quote }], links: [] };
}
function row(n: number): LeadRow { return { personId: `person-${n}`, salesCycleId: `cycle-${n}`, personName: n === 51 ? 'Avery' : `Person ${n}`, initials: 'AP', organization: 'Shared Organization', propertySummary: null, stage: 'ready', source: 'custom', segment: 'warm', priorityContext: null, cloudScores: null, nextAction: null, optedOut: false, lastActivityAt: null }; }
function person(n = 51): LeadDetail {
  return { personId: `person-${n}`, personName: n === 51 ? 'Avery' : `Person ${n}`, salesCycleId: `cycle-${n}`, phones: [],
    emails: [{ id: `email-${n}`, contactSnapshot: 'a'.repeat(64), kind: 'email', value: `person${n}@example.test`, label: 'User supplied work email', valid: true, validationState: 'valid', reachability: 'direct', sourceLabel: 'Imported spreadsheet', vendorRank: null, phoneKind: null, ownershipState: 'unknown', evidenceObservedAt: null, compliance: null }],
    organizationLabel: 'Shared Organization', propertySummaries: [], stage: 'ready', workflowStatus: 'active', sourceLabel: 'custom', segment: 'warm', cloudScores: null, cloudLinked: false, findContactEligibility: { eligible: false, refusalReason: 'qualification_required' }, priorityContext: null, priorityReasons: [], nextAction: null, optedOut: false, cadence: null, outboundAttempts: [], activities: [], conversations: [], properties: [], history: [], revision: 1 };
}
function page(rows = [row(51)], nextCursor: string | null = null): LeadsListResponse { return { rows, nextCursor, total: 52, revision: 7 }; }
const owners: ReturnType<typeof createLocalCompanyContinuation>[] = [];
afterEach(() => { cleanup(); owners.splice(0).forEach(owner => owner.invalidate()); vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture(detail = company()) {
  const owner = createLocalCompanyContinuation(); owners.push(owner); owner.activate(); owner.continuation.selectAccount(owner.continuation.captureEpoch(), detail.snapshot.account.id);
  const forbidden = vi.fn(async () => { throw Error('Unexpected mutation outside link-only contract'); });
  const savedPeople = [person(51), person(52)];
  const api: PanelApi = { leads: { list: vi.fn<PanelApi['leads']['list']>(async () => page()), updateField: forbidden, bulkUpdate: forbidden },
    leadDetail: { get: vi.fn<PanelApi['leadDetail']['get']>(async ({ personId }) => structuredClone(savedPeople.find(item => item.personId === personId)!)), beginOutbound: forbidden, getOutboundCapabilities: forbidden, confirmTransition: forbidden, findContactInfo: forbidden, dismissLead: forbidden, overrideCloudScore: forbidden },
    localWorkspace: { getCompany: vi.fn<PanelApi['localWorkspace']['getCompany']>(async () => detail), linkCompanyPerson: vi.fn<PanelApi['localWorkspace']['linkCompanyPerson']>(async input => ({ accountId: input.accountId, version: input.expectedVersion + 1, duplicate: false })) } };
  const onOpenImport = vi.fn(); const onOpenLead = vi.fn();
  const tree = (next = detail) => <LocalCompanyContactLink detail={next} api={api} continuation={owner.continuation} onOpenImport={onOpenImport} onOpenLead={onOpenLead} />;
  return { api, owner, detail, savedPeople, forbidden, onOpenImport, onOpenLead, tree };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function choose(n = 51) {
  fireEvent.click(screen.getByRole('button', { name: 'Find saved person' }));
  fireEvent.click(await screen.findByRole('button', { name: `Select ${n === 51 ? 'Avery' : `Person ${n}`} · person-${n}` }));
  await screen.findByText(`person${n}@example.test`);
}
async function review() {
  await choose();
  fireEvent.change(screen.getByRole('textbox', { name: 'Role' }), { target: { value: 'Manager' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Relationship' }), { target: { value: 'Manages company' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Source quotation' }), { target: { value: quote } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'I confirm this saved person and quoted relationship' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Link saved person' }) as HTMLButtonElement).disabled).toBe(false));
}
it('T6-C01 read-only office-only mount delegates empty import and never promotes office routes to personal ownership', async () => {
  const detail = company(); detail.sources[0].excerpt = 'Office team: office@a.example +1 401 555 0100';
  detail.snapshot.routes = [{ id: 'office-route', accountId: 'a', personId: null, channel: 'email', value: 'office@a.example', purpose: 'business', evidenceIds: ['source-a'], verification: 'published', version: 1 }];
  const f = fixture(detail); render(f.tree()); expect(await screen.findByText('Contact not established')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Find saved person' })).toBeTruthy();
  expect(f.api.leads.list).not.toHaveBeenCalled(); expect(f.api.leadDetail.get).not.toHaveBeenCalled(); expect(f.api.localWorkspace.getCompany).not.toHaveBeenCalled();
  expect(f.api.localWorkspace.linkCompanyPerson).not.toHaveBeenCalled(); expect(screen.queryByText(/verified person/i)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Import named person' })); expect(f.onOpenImport.mock.calls).toEqual([[]]); expect(screen.queryByRole('dialog')).toBeNull(); expect(f.forbidden).not.toHaveBeenCalled();
}, 10_000);
it('T6-C02 exact 50-row first page and opaque second page select ID 51, not same-name first row', async () => {
  const f = fixture(); const first = Array.from({ length: 50 }, (_, i) => row(i + 1)); first[0].personName = 'Avery';
  vi.mocked(f.api.leads.list).mockResolvedValueOnce(page(first, 'opaque:revision7/page2')).mockResolvedValueOnce(page([row(51), row(52)]));
  render(f.tree()); fireEvent.click(screen.getByRole('button', { name: 'Find saved person' }));
  await screen.findByRole('button', { name: 'Select Avery · person-1' }); expect(f.api.leads.list).toHaveBeenNthCalledWith(1, initialQuery);
  expect(screen.queryByRole('button', { name: 'Select Avery · person-51' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Load more' })); fireEvent.click(await screen.findByRole('button', { name: 'Select Avery · person-51' }));
  await screen.findByText('person51@example.test'); expect(f.api.leads.list).toHaveBeenNthCalledWith(2, { ...initialQuery, cursor: 'opaque:revision7/page2' });
  expect(vi.mocked(f.api.leadDetail.get).mock.calls).toEqual([[{ personId: 'person-51' }]]); expect(f.owner.continuation.snapshot().review.personId).toBe('person-51');
}, 10_000);
it('T6-C03 held old-query page cannot append or change selected person after explicit new query', async () => {
  const f = fixture(); const gate = deferred<LeadsListResponse>();
  vi.mocked(f.api.leads.list).mockResolvedValueOnce(page([row(51)], 'old-cursor')).mockImplementationOnce(() => gate.promise).mockResolvedValueOnce(page([row(52)]));
  const view = render(f.tree());
  try {
    await choose(); fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(f.api.leads.list).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByRole('textbox', { name: 'Saved person search' }), { target: { value: 'Person 52' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search saved people' })); await screen.findByRole('button', { name: 'Select Person 52 · person-52' });
    expect(f.api.leads.list).toHaveBeenNthCalledWith(3, { ...initialQuery, query: 'Person 52' });
    await act(async () => { gate.resolve(page([row(49)])); await gate.promise; });
    expect(screen.queryByRole('button', { name: 'Select Person 49 · person-49' })).toBeNull(); expect(f.owner.continuation.snapshot().review.personId).toBe('person-51');
  } finally { view.unmount(); await act(async () => { gate.resolve(page([])); await Promise.allSettled([gate.promise]); }); }
}, 10_000);
it('T6-C04 stale cursor retains positive reviewed inputs and offers only explicit fresh search', async () => {
  const f = fixture(); vi.mocked(f.api.leads.list).mockResolvedValueOnce(page([row(51)], 'stale')).mockRejectedValueOnce(Object.assign(Error('Cursor is stale'), { code: 'STALE_CURSOR' })).mockResolvedValueOnce(page());
  render(f.tree()); await review(); const held = f.owner.continuation.snapshot().review;
  fireEvent.click(screen.getByRole('button', { name: 'Load more' })); const restart = await screen.findByRole('button', { name: 'Start fresh search' });
  expect(f.api.leads.list).toHaveBeenCalledTimes(2); expect(f.owner.continuation.snapshot().review).toEqual(held);
  expect((screen.getByRole('textbox', { name: 'Source quotation' }) as HTMLInputElement).value).toBe(quote);
  fireEvent.click(restart); await waitFor(() => expect(f.api.leads.list).toHaveBeenCalledTimes(3)); expect(f.api.leads.list).toHaveBeenLastCalledWith(initialQuery);
  expect(f.owner.continuation.snapshot().review.personId).toBe('person-51'); expect(f.api.localWorkspace.linkCompanyPerson).not.toHaveBeenCalled();
}, 10_000);
it('T6-C05 positive selected person and quote confirmation gate, real ownership separate from valid direct defaults', async () => {
  const f = fixture(); render(f.tree()); await review();
  expect(screen.getByText('User supplied work email')).toBeTruthy(); expect(screen.getByText(/ownership.*unknown/i)).toBeTruthy(); expect(screen.getByText(/validation.*valid/i)).toBeTruthy();
  expect(screen.queryByText(/verified person/i)).toBeNull(); expect(screen.getByText('https://a.example/team')).toBeTruthy();
  const confirm = screen.getByRole('checkbox', { name: 'I confirm this saved person and quoted relationship' });
  expect((confirm as HTMLInputElement).checked).toBe(true); fireEvent.click(confirm);
  expect((screen.getByRole('button', { name: 'Link saved person' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Link saved person' })); expect(f.api.localWorkspace.linkCompanyPerson).not.toHaveBeenCalled();
  fireEvent.click(confirm); fireEvent.change(screen.getByRole('textbox', { name: 'Source quotation' }), { target: { value: '' } });
  expect((screen.getByRole('button', { name: 'Link saved person' }) as HTMLButtonElement).disabled).toBe(true); expect(screen.queryByText('Not HTML', { selector: 'b' })).toBeNull();
}, 10_000);
it('T6-C06 exact frozen pending payload, double submit, route remount, rejection and explicit same-request replay', async () => {
  const f = fixture(); const gate = deferred<AccountEvidenceReceipt>(); vi.mocked(f.api.localWorkspace.linkCompanyPerson).mockImplementationOnce(() => gate.promise);
  const before = structuredClone(f.savedPeople); const view = render(f.tree());
  try {
    await review(); const button = screen.getByRole('button', { name: 'Link saved person' }); act(() => { fireEvent.click(button); fireEvent.click(button); });
    expect(f.api.localWorkspace.linkCompanyPerson).toHaveBeenCalledOnce(); const original = vi.mocked(f.api.localWorkspace.linkCompanyPerson).mock.calls[0][0];
    expect(original).toEqual({ commandId: expect.stringMatching(/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i), accountId: 'a', expectedVersion: f.detail.snapshot.account.version,
      link: { id: expect.any(String), kind: 'person_role', personId: 'person-51', role: 'Manager', relationship: 'Manages company', evidenceIds: ['source-a'], authority: 'unconfirmed', authorityEvidenceIds: [], validFrom: expect.any(String), validTo: null }, sourceQuotes: [{ sourceId: 'source-a', quote }] });
    expect(Number.isNaN(Date.parse(original.link.validFrom))).toBe(false); expect(Date.parse(original.link.validFrom)).toBeLessThanOrEqual(Date.now());
    for (const part of [original, original.link, original.link.evidenceIds, original.link.authorityEvidenceIds, original.sourceQuotes, original.sourceQuotes[0]]) expect(Object.isFrozen(part)).toBe(true);
    expect(f.owner.continuation.snapshot().link!.request).toBe(original);
    view.rerender(<div />); view.rerender(f.tree()); expect(f.owner.continuation.snapshot().link!.outcome).toBe('pending'); expect(f.api.localWorkspace.linkCompanyPerson).toHaveBeenCalledOnce();
    await act(async () => { gate.reject(Error('lost reply')); await Promise.allSettled([gate.promise]); });
    const replay = await screen.findByRole('button', { name: 'Replay link' }); expect(f.owner.continuation.snapshot().link!.outcome).toBe('unknown');
    fireEvent.click(replay); await waitFor(() => expect(f.owner.continuation.snapshot().link!.outcome).toBe('known'));
    expect(f.api.localWorkspace.linkCompanyPerson).toHaveBeenCalledTimes(2); expect(vi.mocked(f.api.localWorkspace.linkCompanyPerson).mock.calls[1][0]).toBe(original);
    expect(f.savedPeople).toEqual(before); expect(f.forbidden).not.toHaveBeenCalled();
  } finally { view.unmount(); await act(async () => { gate.resolve({ accountId: 'a', version: 2, duplicate: false }); await Promise.allSettled([gate.promise]); }); }
}, 10_000);
it('T6-C07 dirty review A-B-A survives and explicit discard is required before B editing', async () => {
  const f = fixture(); const view = render(f.tree()); await review(); const held = f.owner.continuation.snapshot().review;
  act(() => { f.owner.continuation.selectAccount(f.owner.continuation.captureEpoch(), 'b'); }); view.rerender(f.tree(company('b')));
  expect(await screen.findByRole('button', { name: 'Return to reviewed account' })).toBeTruthy(); expect(screen.getByRole('button', { name: 'Discard review' })).toBeTruthy();
  expect(f.owner.continuation.snapshot().review).toEqual(held);
  fireEvent.click(screen.getByRole('button', { name: 'Return to reviewed account' })); expect(f.owner.continuation.snapshot().selectedAccountId).toBe('a'); view.rerender(f.tree());
  expect((screen.getByRole('textbox', { name: 'Role' }) as HTMLInputElement).value).toBe('Manager'); expect(f.owner.continuation.snapshot().review).toEqual(held);
}, 10_000);
it('T6-C08 A to B held person detail cannot expose or select A in B', async () => {
  const f = fixture(); const gate = deferred<LeadDetail>(); vi.mocked(f.api.leadDetail.get).mockImplementationOnce(() => gate.promise); const view = render(f.tree());
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Find saved person' })); fireEvent.click(await screen.findByRole('button', { name: 'Select Avery · person-51' }));
    expect(f.api.leadDetail.get).toHaveBeenCalledWith({ personId: 'person-51' });
    act(() => { f.owner.continuation.selectAccount(f.owner.continuation.captureEpoch(), 'b'); }); view.rerender(f.tree(company('b')));
    await act(async () => { gate.resolve(person()); await gate.promise; });
    expect(f.owner.continuation.snapshot().selectedAccountId).toBe('b'); expect(screen.queryByText('person51@example.test')).toBeNull(); expect(f.api.localWorkspace.linkCompanyPerson).not.toHaveBeenCalled();
  } finally { view.unmount(); await act(async () => { gate.resolve(person()); await Promise.allSettled([gate.promise]); }); }
}, 10_000);
it('T6-C09 known saved relationship opens only exact stored person ID, never company route snapshot', async () => {
  const detail = company(); detail.links = [{ id: 'saved-link', kind: 'person_role', personId: 'person-52', role: 'Manager', relationship: 'Manages company', evidenceIds: ['source-a'], authority: 'unconfirmed', authorityEvidenceIds: [], validFrom: at, validTo: null }];
  const f = fixture(detail); render(f.tree()); fireEvent.click(await screen.findByRole('button', { name: 'Open saved contact' }));
  expect(f.onOpenLead.mock.calls).toEqual([['person-52']]); expect(f.api.localWorkspace.linkCompanyPerson).not.toHaveBeenCalled(); expect(f.api.localWorkspace.getCompany).not.toHaveBeenCalled();
}, 10_000);
it('T6-C10 wrong-account receipt is unknown, not established, and explicit replay preserves request', async () => {
  const f = fixture(); vi.mocked(f.api.localWorkspace.linkCompanyPerson).mockResolvedValueOnce({ accountId: 'b', version: 2, duplicate: false }); render(f.tree()); await review();
  fireEvent.click(screen.getByRole('button', { name: 'Link saved person' })); await screen.findByRole('button', { name: 'Replay link' });
  expect(f.owner.continuation.snapshot().link!.outcome).toBe('unknown'); expect(screen.queryByRole('button', { name: 'Open saved contact' })).toBeNull();
  const original = vi.mocked(f.api.localWorkspace.linkCompanyPerson).mock.calls[0][0]; fireEvent.click(screen.getByRole('button', { name: 'Replay link' }));
  await waitFor(() => expect(f.owner.continuation.snapshot().link!.outcome).toBe('known')); expect(vi.mocked(f.api.localWorkspace.linkCompanyPerson).mock.calls[1][0]).toBe(original);
}, 10_000);
it('T6-C11 multiple sources require explicit source choice and bind exact selected ID, not first source', async () => {
  const detail = company(); detail.sources.unshift({ ...detail.sources[0], id: 'office-first', url: 'https://a.example/office', excerpt: 'Office team only.' });
  const f = fixture(detail); render(f.tree()); await choose();
  fireEvent.change(screen.getByRole('combobox', { name: 'Relationship source' }), { target: { value: 'source-a' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Role' }), { target: { value: 'Manager' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Relationship' }), { target: { value: 'Manages company' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Source quotation' }), { target: { value: quote } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'I confirm this saved person and quoted relationship' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Link saved person' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Link saved person' })); await waitFor(() => expect(f.api.localWorkspace.linkCompanyPerson).toHaveBeenCalledOnce());
  const sent = vi.mocked(f.api.localWorkspace.linkCompanyPerson).mock.calls[0][0]; expect(sent.sourceQuotes).toEqual([{ sourceId: 'source-a', quote }]); expect(sent.link.evidenceIds).toEqual(['source-a']);
}, 10_000);

it('T6-C12 nonexact quotation refuses only after a valid explicitly confirmed review is reachable', async () => {
  const f = fixture(); render(f.tree()); await review();
  fireEvent.change(screen.getByRole('textbox', { name: 'Source quotation' }), { target: { value: 'Avery owns every company.' } });
  const confirm = screen.getByRole('checkbox', { name: 'I confirm this saved person and quoted relationship' });
  if (!(confirm as HTMLInputElement).checked) fireEvent.click(confirm);
  expect((screen.getByRole('button', { name: 'Link saved person' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Link saved person' })); expect(f.api.localWorkspace.linkCompanyPerson).not.toHaveBeenCalled();
}, 10_000);
it('T6-C13 elapsed time cannot manufacture known or unknown while a real invocation is still pending', async () => {
  const f = fixture(); const gate = deferred<AccountEvidenceReceipt>(); vi.mocked(f.api.localWorkspace.linkCompanyPerson).mockImplementationOnce(() => gate.promise);
  const view = render(f.tree());
  try {
    await review(); vi.useFakeTimers(); // Installed BEFORE dispatch, not after any product timeout could be scheduled.
    fireEvent.click(screen.getByRole('button', { name: 'Link saved person' })); expect(f.api.localWorkspace.linkCompanyPerson).toHaveBeenCalledOnce();
    const original = f.owner.continuation.snapshot().link!.request;
    await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
    expect(f.owner.continuation.snapshot().link!.outcome).toBe('pending'); expect(f.owner.continuation.snapshot().link!.request).toBe(original);
    const replay = screen.queryByRole('button', { name: 'Replay link' });
    if (replay) { expect((replay as HTMLButtonElement).disabled).toBe(true); fireEvent.click(replay); }
    expect(f.api.localWorkspace.linkCompanyPerson).toHaveBeenCalledOnce();
  } finally { view.unmount(); await act(async () => { gate.resolve({ accountId: 'a', version: 2, duplicate: false }); await Promise.allSettled([gate.promise]); }); vi.useRealTimers(); }
}, 10_000);
it('T6-C14 later exact-person choice wins over older same-account detail completion', async () => {
  const f = fixture(); const gate = deferred<LeadDetail>(); vi.mocked(f.api.leads.list).mockResolvedValue(page([row(51), row(52)]));
  vi.mocked(f.api.leadDetail.get).mockImplementationOnce(() => gate.promise).mockResolvedValueOnce(person(52)); const view = render(f.tree());
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Find saved person' })); fireEvent.click(await screen.findByRole('button', { name: 'Select Avery · person-51' }));
    expect(f.api.leadDetail.get).toHaveBeenCalledWith({ personId: 'person-51' }); fireEvent.click(screen.getByRole('button', { name: 'Select Person 52 · person-52' }));
    await screen.findByText('person52@example.test'); expect(f.owner.continuation.snapshot().review.personId).toBe('person-52');
    await act(async () => { gate.resolve(person(51)); await gate.promise; });
    expect(screen.getByText('person52@example.test')).toBeTruthy(); expect(screen.queryByText('person51@example.test')).toBeNull(); expect(f.owner.continuation.snapshot().review.personId).toBe('person-52');
  } finally { view.unmount(); await act(async () => { gate.resolve(person(51)); await Promise.allSettled([gate.promise]); }); }
}, 10_000);

it('T6-C15 failed saved-person read never authorizes a reviewed link or replaces a saved contact snapshot', async () => {
  const f = fixture(); vi.mocked(f.api.leadDetail.get).mockRejectedValueOnce(Error('Saved person unavailable')); render(f.tree());
  fireEvent.click(screen.getByRole('button', { name: 'Find saved person' })); fireEvent.click(await screen.findByRole('button', { name: 'Select Avery · person-51' }));
  expect(f.api.leadDetail.get).toHaveBeenCalledWith({ personId: 'person-51' }); await screen.findByText(/Saved person unavailable/i);
  expect(screen.queryByText('person51@example.test')).toBeNull(); expect(screen.getByRole('button', { name: 'Import named person' })).toBeTruthy();
  expect(f.api.localWorkspace.linkCompanyPerson).not.toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled();
}, 10_000);
