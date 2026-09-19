// @vitest-environment jsdom
import { randomUUID } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { FounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { createLocalWorkspaceProvider } from '../../src/main/workspace/localWorkspaceProvider';
import { NativeDeskRoute } from '../../src/renderer/features/today/NativeDeskRoute';
import { PresentationRoot } from '../../src/renderer/app/PresentationRoot';
import { nativeDeskFixture } from '../../src/renderer/features/today/nativeDesk.fixture';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';
import { seedLocalWorkspaceAcceptance } from '../fixtures/localWorkspaceAcceptance';

afterEach(cleanup);
async function fixture() {
  const temp = createTempDatabase(), key = createTestWorkspaceKey();
  const database = openDatabase({path: temp.path, key});
  await migrateToLatest(database, {workspaceKey: key, backupDirectory: `${temp.path}.backups`});
  const seeded = seedLocalWorkspaceAcceptance(database);
  const clock = {now: () => '2026-09-09T12:00:00.000Z'}, ids = {next: randomUUID};
  const services = createDomainServices({database, clock, ids});
  const domain = new FounderSalesDomain({database, services, clock, ids, timezone: 'America/New_York'});
  const provider = createLocalWorkspaceProvider({withDatabase: async operation => operation(database), withDomain: async operation => operation(domain)});
  const ui = nativeDeskFixture(services.daily.get());
  const forbidden = vi.fn(async () => { throw Error('Unexpected command during local viewing'); });
  Object.assign(ui.api.delegation, {sync: forbidden, getRequestedFollowup: forbidden, prepareRequestedFollowup: forbidden, editRequestedFollowup: forbidden, approveRequestedFollowup: forbidden});
  ui.api.daily.get = vi.fn(async () => services.daily.get());
  const api = {...ui.api, localWorkspace: provider};
  const snapshot = () => Object.fromEntries(['sales_cycles', 'next_actions', 'activities', 'stage_events', 'source_intake_receipts', 'workflow_transition_receipts', 'pm_accounts', 'delegated_authorities', 'delegated_commands'].map(table => [table, database.raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  return {database, seeded, domain, provider, api, firstUse: ui.firstUse, forbidden, snapshot, close() {cleanup(); closeDatabase(database); key.bytes.fill(0); temp.cleanup();}};
}

it('actual unpaired reads preserve a callback across transition and render it without command or lifecycle writes', async () => {
  const f = await fixture();
  try {
    const before = f.snapshot();
    const initial = await f.provider.getCommitments();
    expect(initial.items).toHaveLength(1);
    expect(initial.items[0]).toMatchObject({kind: 'callback', item: {personId: f.seeded.personId, action: {id: f.seeded.actionId, dueAt: f.seeded.callbackAt}}});
    expect(f.snapshot()).toEqual(before);
    const receipt = await f.provider.transition({commandId: 'composition-transition', expectedMode: 'legacy', manifestId: 'composition-manifest'});
    expect(receipt.preservedActionIds).toContain(f.seeded.actionId);
    expect((await f.provider.getCommitments()).items).toEqual(initial.items);
    const after = f.snapshot();
    render(<PresentationRoot><NativeDeskRoute firstUse={f.firstUse} api={f.api}/></PresentationRoot>);
    fireEvent.click(await screen.findByRole('button', {name: /Retained callback Property Owner/}));
    expect(screen.queryByText(/Old acquisition Property Owner/)).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: 'Refresh'}));
    await waitFor(() => expect(f.api.daily.get).toHaveBeenCalledTimes(2));
    // The retained detail is local presentation only; the contact workspace left with the legacy routes.
    const detail = screen.getByRole('region', {name: 'Retained work detail'});
    expect(detail.textContent).toContain('Stored local work. Nothing here calls, sends or books.');
    expect(screen.queryByRole('button', {name: 'Open contact workspace'})).toBeNull();
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(f.snapshot()).toEqual(after);
    expect(await f.api.daily.get()).toMatchObject({workspaceId: null, accounts: [], answers: [], meetings: [], ownerStatus: []});
  } finally {f.close();}
});

it('actual local account evidence is separately selectable without authorizing an unpaired daily account', async () => {
  const f = await fixture();
  try {
    await f.provider.transition({commandId: 'account-transition', expectedMode: 'legacy', manifestId: 'account-manifest'});
    const before = f.snapshot();
    render(<PresentationRoot><NativeDeskRoute firstUse={f.firstUse} api={f.api} surface="accounts"/></PresentationRoot>);
    await screen.findByText('Local account library', {exact: true});
    const row = await screen.findByRole('button', {name: 'Local account · Fixture Residential Management'});
    // Real provider: saved source, no published business inbox. The step is a plain local reason, not worker authority.
    expect(row.textContent).toContain('Saved evidence has no published business inbox.');
    fireEvent.click(screen.getByRole('button', {name: 'Open route review · Fixture Residential Management'}));
    expect(screen.getByRole('heading', {name: 'Fixture Residential Management'})).toBeTruthy();
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(f.snapshot()).toEqual(before);
    expect((await f.api.daily.get()).accounts).toEqual([]);
  } finally {f.close();}
});

const lenoxQuote = 'Contact Us\n\n380 Broadway Providence, Rhode Island 02909\n\ninfo@lenoxmanagement.com\n\n401-572-3322';
/** Real repository and provider writes only: one saved source, one reviewed business inbox, one opened draft, one saved edit. */
async function seedLenoxDraft(f: Awaited<ReturnType<typeof fixture>>) {
  const clock = {now: () => '2026-09-09T12:00:00.000Z'}, ids = {next: randomUUID};
  const accounts = new AccountRepository({database: f.database, clock, ids, sourcePolicy: {attest: () => true}});
  const account = accounts.create({commandId: randomUUID(), name: 'Lenox Management', domain: 'lenoxmanagement.com'});
  const sourceId = randomUUID();
  accounts.admitEvidence({commandId: randomUUID(), accountId: account.id, expectedVersion: account.version, sources: [{id: sourceId,
    url: 'https://lenoxmanagement.com/', fetchedAt: clock.now(), sha256: 'b'.repeat(64), excerpt: lenoxQuote, permitted: true}], claims: [], routes: []});
  const admitted = await f.provider.admitCompanyDraftEmail({commandId: randomUUID(), accountId: account.id, expectedAccountVersion: account.version + 1,
    email: 'info@lenoxmanagement.com', sourceId, quote: lenoxQuote, selection: 'published_company_business_inbox'});
  const opened = await f.provider.openCompanyDraft({commandId: randomUUID(), accountId: account.id, routeId: admitted.recipientBinding.routeId,
    expectedRouteVersion: admitted.recipientBinding.routeVersion, expectedAccountVersion: admitted.accountVersion});
  const saved = await f.provider.saveCompanyDraft({commandId: randomUUID(), accountId: account.id, draftId: opened.current.draft.id, expectedRevision: 1,
    subject: 'Maintenance request coordination at Lenox', body: 'Hello Lenox Management team,\n\nHow does your team handle incoming maintenance requests?'});
  return {accountId: account.id, draftId: opened.current.draft.id, revision: saved.current.draft.revision};
}

it('actual unsent local draft appears in Today without a worker and opens its company with the draft panel focused', async () => {
  const f = await fixture();
  // jsdom has no scrollIntoView; the route must still move focus into the named panel.
  const scrollIntoView = vi.fn(), originalScroll = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scrollIntoView;
  window.location.hash = '';
  try {
    await f.provider.transition({commandId: 'draft-transition', expectedMode: 'legacy', manifestId: 'draft-manifest'});
    const lenox = await seedLenoxDraft(f);
    expect(lenox.revision).toBe(2);
    const before = f.snapshot();
    const view = render(<PresentationRoot><NativeDeskRoute firstUse={f.firstUse} api={f.api}/></PresentationRoot>);
    // No worker: the daily snapshot has no workspace. The unsent local draft still surfaces as a local continuation.
    const row = await screen.findByRole('button', {name: 'Lenox Management · Local unsent draft · revision 2'});
    expect(row.textContent).not.toMatch(/worker|owner|send|approve/i);
    expect(screen.getByRole('button', {name: /Retained callback Property Owner/})).toBeTruthy();
    const lane = screen.getByRole('heading', {name: /^Saved draft continuations/}).closest('section')!;
    const meetings = screen.getByRole('heading', {name: /^Upcoming meetings/}).closest('section')!;
    expect(lane.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.compareDocumentPosition(meetings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(row);
    expect(f.firstUse.snapshot().selectedAccountId).toBe(lenox.accountId);
    expect(window.location.hash).toBe('#/accounts');
    view.unmount();
    // The app remounts the route per hash route. Selection and the requested draft step survive the remount.
    render(<PresentationRoot><NativeDeskRoute firstUse={f.firstUse} api={f.api} surface="accounts"/></PresentationRoot>);
    await screen.findByRole('heading', {name: 'Lenox Management'});
    expect(screen.getByRole('button', {name: 'Local account · Lenox Management'}).getAttribute('aria-current')).toBe('true');
    const panel = await screen.findByRole('region', {name: 'Company draft'});
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
    expect(scrollIntoView).toHaveBeenCalledWith({block: 'start'});
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(f.snapshot()).toEqual(before);
  } finally { Element.prototype.scrollIntoView = originalScroll; window.location.hash = ''; f.close(); }
});
