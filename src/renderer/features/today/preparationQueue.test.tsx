// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { localWorkspaceSnapshotSchema, type LocalAccountPreparation, type LocalAccountPreparationStep, type LocalAccountSnapshot, type LocalWorkspaceApi } from '../../../shared/contracts/localWorkspaceContract';
import { LocalOnlyAccountLibrary, localAccountKey } from './LocalAccountLibrary';
import type { LocalCompanyContactApi } from './LocalCompanyContactLink';
import { createLocalCompanyContinuation } from './localCompanyContinuation';
import { preparationControlLabel, preparationSummary, rankPreparationQueue } from './preparationQueue';
afterEach(cleanup);

const NOW = '2026-09-09T12:00:00.000Z';
const flags: Record<LocalAccountPreparationStep, Pick<LocalAccountPreparation, 'researched' | 'unsentDraft' | 'businessRoute'>> = {
  reopen_draft: { researched: true, unsentDraft: true, businessRoute: true }, draft: { researched: true, unsentDraft: false, businessRoute: true },
  add_route: { researched: true, unsentDraft: false, businessRoute: false }, research: { researched: false, unsentDraft: false, businessRoute: false },
  unknown: { researched: null, unsentDraft: null, businessRoute: null },
};
const prepared = (nextStep: LocalAccountPreparationStep, reason: string): LocalAccountPreparation => ({ ...flags[nextStep], nextStep, reason });
const company = (id: string, name: string, preparation?: LocalAccountPreparation): LocalAccountSnapshot => ({
  account: { id, name, domain: null, version: 1 }, claims: [], routes: [], portfolio: [], unknowns: [], conflicts: [], fingerprint: 'a'.repeat(64), ...(preparation ? { preparation } : {}),
});
const reasons = {
  a: 'No research or saved sources yet. Research is an explicit step.', b: 'Saved evidence has no published business inbox.',
  c: 'Saved evidence and a published business inbox are ready for an explicit draft.', d: 'An unsent local draft is saved. Reopen to review.',
  f: 'Local preparation evidence unavailable for this company.',
};
// Deliberately scrambled input. The library, not the snapshot, owns the ranked presentation.
const snapshot = localWorkspaceSnapshotSchema.parse({ scope: 'local_database', generatedAt: NOW, workflowMode: 'meeting_first', transitionReceipt: null, accounts: { state: 'available', snapshots: [
  company('a', 'Alpha New PM', prepared('research', reasons.a)), company('e', 'Echo Unassessed PM'), company('d', 'Delta Draft PM', prepared('reopen_draft', reasons.d)),
  company('f', 'Foxtrot Unknown PM', prepared('unknown', reasons.f)), company('c', 'Charlie Ready PM', prepared('draft', reasons.c)), company('b', 'Bravo Routeless PM', prepared('add_route', reasons.b)),
] } });
const commandMethods = ['prepareCompanyDraft', 'admitCompanyDraftEmail', 'openCompanyDraft', 'saveCompanyDraft', 'updateCompanyResearchSettings', 'updateCallSettings', 'linkCompanyPerson', 'researchCompany', 'reviewCompany', 'createCompany', 'transition'] as const;
const readMethods = ['getCompanyDraft', 'getCompanyResearchSettings', 'getCallSettings', 'getCompanyResearchStatus', 'getCompany', 'getCompanyCreateStatus', 'get', 'getCommitments'] as const;
type SpiedApi = { [K in keyof LocalWorkspaceApi]: ReturnType<typeof vi.fn> };
function spiedApi(): SpiedApi {
  const entries = [...commandMethods, ...readMethods].map(method => [method, vi.fn(async () => { throw new Error(`${method} unavailable in this fixture`); })]);
  const api = Object.fromEntries(entries) as SpiedApi;
  const complete: LocalWorkspaceApi = api;
  expect(Object.keys(complete)).toHaveLength(19);
  return api;
}
function mount(value = snapshot) {
  const owner = createLocalCompanyContinuation(); owner.activate();
  const api = spiedApi(), onOpenImport = vi.fn(), onOpenLead = vi.fn(), onSelectionChange = vi.fn();
  const forbidden = vi.fn(async () => { throw new Error('Unexpected contact read'); });
  const contactApi = { leads: { list: forbidden, updateField: forbidden, bulkUpdate: forbidden }, leadDetail: { get: forbidden } } as unknown as Pick<LocalCompanyContactApi, 'leads' | 'leadDetail'>;
  render(<LocalOnlyAccountLibrary read={{ value, pending: false, error: false }} api={api} contactApi={contactApi} onOpenImport={onOpenImport} onOpenLead={onOpenLead} firstUse={owner.continuation} onSelectionChange={onSelectionChange} />);
  return { api, onOpenImport, onOpenLead, onSelectionChange, continuation: owner.continuation, forbidden };
}
const rows = () => screen.getAllByRole('button', { name: /^Local account · / });
const noCommands = (api: SpiedApi) => { for (const method of commandMethods) expect(api[method], method).not.toHaveBeenCalled(); };

it('ranks rows most ready first, keeps row identities, and shows one reason and one next-step control per assessed company', () => {
  const f = mount();
  expect(rows().map(row => row.getAttribute('data-row-key'))).toEqual(['d', 'c', 'b', 'a', 'f', 'e'].map(localAccountKey));
  expect(rows().map(row => row.getAttribute('aria-label'))).toEqual(['Delta Draft PM', 'Charlie Ready PM', 'Bravo Routeless PM', 'Alpha New PM', 'Foxtrot Unknown PM', 'Echo Unassessed PM'].map(name => `Local account · ${name}`));
  for (const [id, reason] of Object.entries(reasons)) expect(within(screen.getByRole('button', { name: `Local account · ${snapshot.accounts.state === 'available' ? snapshot.accounts.snapshots.find(s => s.account.id === id)!.account.name : ''}` })).getByText(reason)).toBeTruthy();
  expect(screen.getByRole('button', { name: `${preparationControlLabel.reopen_draft} · Delta Draft PM` })).toBeTruthy();
  expect(screen.getByRole('button', { name: `${preparationControlLabel.draft} · Charlie Ready PM` })).toBeTruthy();
  expect(screen.getByRole('button', { name: `${preparationControlLabel.add_route} · Bravo Routeless PM` })).toBeTruthy();
  expect(screen.getByRole('button', { name: `${preparationControlLabel.research} · Alpha New PM` })).toBeTruthy();
  expect(screen.getByRole('button', { name: `${preparationControlLabel.unknown} · Foxtrot Unknown PM` })).toBeTruthy();
  // The control is styled by its class alone, so the stylesheet owns its spacing.
  const step = screen.getByRole('button', { name: `${preparationControlLabel.draft} · Charlie Ready PM` });
  expect(step.className).toBe('native-desk__row-step');
  expect(step.getAttribute('style')).toBeNull();
  // Snapshots without a preparation summary render exactly as before: one row, no control, no invented reason.
  expect(screen.getAllByRole('button', { name: /Echo Unassessed PM/ })).toHaveLength(1);
  expect(within(screen.getByRole('button', { name: 'Local account · Echo Unassessed PM' })).queryByText(/prepar|research|draft/i)).toBeNull();
  expect(screen.queryByText(/worker|authority/i)?.textContent).toBe('Stored local evidence only. Worker ownership is not established by this view.');
  for (const method of readMethods) expect(f.api[method], method).not.toHaveBeenCalled();
  noCommands(f.api);
});

it('next-step controls only select the company through the existing continuation and never issue a command', async () => {
  const f = mount();
  fireEvent.click(screen.getByRole('button', { name: `${preparationControlLabel.draft} · Charlie Ready PM` }));
  expect(f.continuation.snapshot().selectedAccountId).toBe('c');
  expect(f.onSelectionChange).toHaveBeenLastCalledWith(localAccountKey('c'));
  expect(screen.getByRole('button', { name: 'Local account · Charlie Ready PM' }).getAttribute('aria-current')).toBe('true');
  expect(screen.getByRole('heading', { name: 'Charlie Ready PM' })).toBeTruthy();
  // The existing detail reads company evidence; it is the founder's explicit Research/Open draft buttons that ever command.
  await waitFor(() => expect(f.api.getCompany).toHaveBeenCalledWith({ accountId: 'c' }));
  noCommands(f.api);
  fireEvent.click(screen.getByRole('button', { name: `${preparationControlLabel.add_route} · Bravo Routeless PM` }));
  expect(f.continuation.snapshot().selectedAccountId).toBe('b');
  expect(screen.getByRole('heading', { name: 'Bravo Routeless PM' })).toBeTruthy();
  expect(f.onOpenImport).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: `${preparationControlLabel.reopen_draft} · Delta Draft PM` }));
  expect(f.continuation.snapshot().selectedAccountId).toBe('d');
  fireEvent.click(screen.getByRole('button', { name: `${preparationControlLabel.unknown} · Foxtrot Unknown PM` }));
  expect(f.continuation.snapshot().selectedAccountId).toBe('f');
  await waitFor(() => expect(f.api.getCompany).toHaveBeenCalledWith({ accountId: 'f' }));
  noCommands(f.api);
  expect(f.onOpenLead).not.toHaveBeenCalled();
  expect(f.forbidden).not.toHaveBeenCalled();
  expect(f.api.researchCompany).not.toHaveBeenCalled();
  expect(f.api.openCompanyDraft).not.toHaveBeenCalled();
});

it('unavailable local accounts stay an honest unavailable state with no ranked rows or controls', () => {
  const f = mount({ ...snapshot, accounts: { state: 'unavailable', snapshots: [] } });
  expect(screen.getByRole('status').textContent).toMatch(/Local account library is unavailable/);
  expect(screen.queryAllByRole('button', { name: /^Local account · / })).toHaveLength(0);
  expect(screen.queryAllByRole('button', { name: / · .+ PM$/ })).toHaveLength(0);
  expect(screen.queryByText(/ready|prepared/i)).toBeNull();
  noCommands(f.api);
});

it('pure ranking follows the contract enum order, breaks ties by name then id, and leaves unassessed rows in place at the end', () => {
  if (snapshot.accounts.state !== 'available') throw new Error('Expected available fixture');
  const ranked = rankPreparationQueue(snapshot.accounts.snapshots);
  expect(ranked.map(s => s.account.id)).toEqual(['d', 'c', 'b', 'a', 'f', 'e']);
  expect(ranked).not.toBe(snapshot.accounts.snapshots);
  const ties = [company('z', 'Zulu PM', prepared('draft', 'x')), company('y', 'Yankee PM', prepared('draft', 'x')), company('y0', 'Yankee PM', prepared('draft', 'x')), company('u2', 'Unassessed 2'), company('u1', 'Unassessed 1')];
  expect(rankPreparationQueue(ties).map(s => s.account.id)).toEqual(['y', 'y0', 'z', 'u2', 'u1']);
  expect(preparationSummary(undefined)).toEqual({ reason: null, label: null });
  expect(preparationSummary(prepared('unknown', 'Unavailable.'))).toEqual({ reason: 'Unavailable.', label: preparationControlLabel.unknown });
  for (const label of Object.values(preparationControlLabel)) expect(label).not.toMatch(/run|start|send|approve|create/i);
});
