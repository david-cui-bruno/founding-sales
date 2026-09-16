// @vitest-environment jsdom
import { randomUUID } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
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
  Object.assign(ui.api.linkedin, {prepare: forbidden, get: forbidden, recover: forbidden, save: forbidden, begin: forbidden, open: forbidden, copy: forbidden, reportOutcome: forbidden});
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
    const open = vi.fn();
    render(<PresentationRoot><NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} onOpenLead={open}/></PresentationRoot>);
    fireEvent.click(await screen.findByRole('button', {name: /Retained callback Property Owner/}));
    expect(open).not.toHaveBeenCalled();
    expect(screen.queryByText(/Old acquisition Property Owner/)).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: 'Refresh'}));
    await waitFor(() => expect(f.api.daily.get).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', {name: 'Open contact workspace'}));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(f.seeded.personId);
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(f.snapshot()).toEqual(after);
    expect(await f.api.daily.get()).toMatchObject({workspaceId: null, accounts: [], answers: [], meetings: [], ownerStatus: []});
  } finally {f.close();}
});

it('actual local account evidence is separately selectable without authorizing an unpaired daily account', async () => {
  const f = await fixture();
  try {
    await f.provider.transition({commandId: 'account-transition', expectedMode: 'legacy', manifestId: 'account-manifest'});
    const before = f.snapshot(), open = vi.fn();
    render(<PresentationRoot><NativeDeskRoute onOpenImport={(): void => undefined} firstUse={f.firstUse} api={f.api} onOpenLead={open} surface="accounts"/></PresentationRoot>);
    await screen.findByText('Local account library', {exact: true});
    const row = await screen.findByRole('button', {name: 'Local account · Fixture Residential Management'});
    // Real provider: saved source, no published business inbox. The step is a plain local reason, not worker authority.
    expect(row.textContent).toContain('Saved evidence has no published business inbox.');
    fireEvent.click(screen.getByRole('button', {name: 'Open route review · Fixture Residential Management'}));
    expect(screen.getByRole('heading', {name: 'Fixture Residential Management'})).toBeTruthy();
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(open).not.toHaveBeenCalled();
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(f.snapshot()).toEqual(before);
    expect((await f.api.daily.get()).accounts).toEqual([]);
  } finally {f.close();}
});
