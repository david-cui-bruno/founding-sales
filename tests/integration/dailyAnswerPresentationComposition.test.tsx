// @vitest-environment jsdom
import { randomUUID, createHash } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createCampaignFixture } from '../fixtures/campaignWorkspace';
import { createLinkedInFixture } from '../fixtures/linkedInWorkspace';
import { requestedFollowupFixture } from '../fixtures/requestedFollowup';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { accountFingerprint } from '../../src/main/domain/accounts/accountEvidence';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { FounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { createLocalWorkspaceProvider } from '../../src/main/workspace/localWorkspaceProvider';
import { NativeDeskRoute } from '../../src/renderer/features/today/NativeDeskRoute';
import { PresentationRoot } from '../../src/renderer/app/PresentationRoot';
import { configuredFixtureStatus, nativeDeskFixture } from '../../src/renderer/features/today/nativeDesk.fixture';
import type { RequestedFollowupDraft } from '../../src/shared/contracts/requestedFollowupContract';

afterEach(cleanup);
async function requestedSource(ownerSupplied = false) {
  const f = await createCampaignFixture();
  const raw = f.db.raw;
  raw.prepare('INSERT INTO persons(id,display_name,created_at,updated_at) VALUES(?,?,?,?)').run('person-nora', 'Nora Source', f.now, f.now);
  const accounts = new AccountRepository({ database: f.db, clock: f.clock, ids: { next: randomUUID }, sourcePolicy: { attest: () => true } });
  const route = { id: 'email-nora', accountId: f.account.id, personId: 'person-nora', channel: 'email' as const, value: 'nora@fixture.invalid', purpose: 'business' as const, verification: 'published' as const, evidenceIds: ['source-nora'] };
  accounts.admitEvidence({ commandId: randomUUID(), accountId: f.account.id, expectedVersion: 2, claims: [],
    sources: [{ id: 'source-nora', url: 'https://example.invalid/team', fetchedAt: f.now, sha256: 'c'.repeat(64), excerpt: 'Nora Source, portfolio manager.', permitted: true }],
    routes: [route, { ...route, id: 'phone1', channel: 'phone', value: '+12025550123' }] });
  accounts.admitLinks({ commandId: randomUUID(), accountId: f.account.id, expectedVersion: 3, links: [{ id: 'role-nora', kind: 'person_role', personId: 'person-nora', role: 'Portfolio manager', relationship: 'team', authority: 'unconfirmed', authorityEvidenceIds: [], evidenceIds: ['source-nora'], validFrom: '2026-01-01T00:00:00.000Z', validTo: null }] });
  const call = requestedFollowupFixture(f.account.id, 4, 'Please email a short outline.');
  const h = { ...call.handoff, targetHash: createHash('sha256').update('+12025550123').digest('hex') };
  const command = { ...call.command, workspaceId: f.workspaceId, payload: { ...call.command.payload, targetHash: h.targetHash } };
  const event = { ...call.event, workspaceId: f.workspaceId };
  const handoffEvent = { ...call.handoffEvent, workspaceId: f.workspaceId, payload: h };
  const ref = { ...call.ref, commandFingerprint: accountFingerprint(command), outcomeEventHash: accountFingerprint(event) };
  const draft: RequestedFollowupDraft = { ...call.draft, originalCall: ref, recipient: route.value,
    recipientBinding: ownerSupplied ? { kind: 'owner_supplied', email: route.value, originalCall: ref } : { kind: 'account_route', routeId: route.id, routeVersion: 1, email: route.value } };
  raw.prepare('INSERT INTO delegated_commands VALUES(?,?,?,?,?,?,?)').run(command.commandId, f.workspaceId, f.account.id, ref.commandFingerprint, JSON.stringify(command), JSON.stringify(call.receipt), f.now);
  for (const e of [handoffEvent, event]) raw.prepare('INSERT INTO delegated_applied_events VALUES(?,?,?,?,?,?,?,?,?)').run(e.id, f.workspaceId, f.account.id, 'execution', e.aggregateVersion, e.authorityGeneration, accountFingerprint(e), JSON.stringify(e), f.now);
  raw.prepare('INSERT INTO delegated_manual_handoffs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(f.workspaceId, f.account.id, h.handoffId, h.actionId, 0, h.targetHash, h.contentHash, h.contextRevision, h.channel, h.routeId, h.routeVersion, h.expiresAt, handoffEvent.id, f.now, null);
  raw.prepare('INSERT INTO delegated_requested_followup_drafts VALUES(?,?,?,?,?,?,?,?)').run(f.workspaceId, f.account.id, draft.id, draft.revision, draft.contextRevision, JSON.stringify(draft), null, f.now);
  return { ...f, draft };
}
function actualReaderUi(f: Awaited<ReturnType<typeof createCampaignFixture>>) {
  const services = createDomainServices({ database: f.db, clock: f.clock, ids: { next: randomUUID }, expectedWorkspaceId: f.workspaceId });
  const domain = new FounderSalesDomain({ database: f.db, services, clock: f.clock, ids: { next: randomUUID }, timezone: 'America/New_York' });
  domain.transitionWorkflow({ commandId: randomUUID(), expectedMode: 'legacy', manifestId: randomUUID() });
  const local = createLocalWorkspaceProvider({ withDatabase: async op => op(f.db), withDomain: async op => op(domain) });
  const ui = nativeDeskFixture(services.daily.get());
  ui.setConfiguration({ ...configuredFixtureStatus(), workspaceId: f.workspaceId });
  const forbidden = vi.fn(async () => { throw Error('Display attempted an execution command'); });
  Object.assign(ui.api.delegation, { sync: forbidden, getRequestedFollowup: forbidden, prepareRequestedFollowup: forbidden, editRequestedFollowup: forbidden, approveRequestedFollowup: forbidden });
  Object.assign(ui.api.linkedin, { prepare: forbidden, get: forbidden, recover: forbidden, save: forbidden, begin: forbidden, open: forbidden, copy: forbidden, reportOutcome: forbidden });
  const get = vi.fn(async () => services.daily.get());
  ui.api.daily.get = get;
  const api = { ...ui.api, localWorkspace: local };
  const snapshot = () => Object.fromEntries(['persons', 'pm_accounts', 'pm_account_routes', 'pm_account_links', 'delegated_commands', 'delegated_applied_events', 'delegated_requested_followup_drafts', 'manual_linkedin_drafts', 'workflow_transition_receipts'].map(t => [t, f.db.raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
  return { api, firstUse: ui.firstUse, forbidden, snapshot, get };
}

it('real encrypted daily joins produce the A identity and call context without executing or rewriting saved work', async () => {
  const f = await requestedSource();
  try {
    const ui = actualReaderUi(f), before = ui.snapshot(), changes = f.db.raw.prepare('SELECT total_changes() n').get();
    f.db.raw.pragma('query_only=ON');
    const view = render(<PresentationRoot><NativeDeskRoute onOpenImport={(): void => undefined} firstUse={ui.firstUse} api={ui.api} onOpenLead={ui.forbidden} /></PresentationRoot>);
    await waitFor(() => expect(view.container.querySelector('[data-row-key="requested_followup:' + f.account.id + ':' + f.draft.id + '"]')).toBeTruthy());
    fireEvent.click(view.container.querySelector('[data-row-key="requested_followup:' + f.account.id + ':' + f.draft.id + '"]')!);
    const detail = within(view.container.querySelector('.native-desk__detail')! as HTMLElement);
    expect(detail.getByRole('heading', { name: 'Nora Source' })).toBeTruthy();
    expect(detail.getByText('Portfolio manager')).toBeTruthy();
    expect(detail.getByText('Human-reported call note')).toBeTruthy();
    expect(detail.getByText('Please email a short outline.')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Email body' }) as HTMLTextAreaElement).value).toBe(f.draft.body);
    expect((screen.getByRole('button', { name: 'Approve email' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(ui.get).toHaveBeenCalledTimes(2));
    expect(ui.snapshot()).toEqual(before); expect(f.db.raw.prepare('SELECT total_changes() n').get()).toEqual(changes);
    expect(ui.forbidden).not.toHaveBeenCalled();
  } finally { cleanup(); f.close(); }
});

it('owner-supplied email never inherits the named phone contact as recipient identity', async () => {
  const f = await requestedSource(true);
  try {
    const ui = actualReaderUi(f); f.db.raw.pragma('query_only=ON');
    const view = render(<PresentationRoot><NativeDeskRoute onOpenImport={(): void => undefined} firstUse={ui.firstUse} api={ui.api} onOpenLead={ui.forbidden} /></PresentationRoot>);
    await waitFor(() => expect(view.container.querySelector('[data-row-key="requested_followup:' + f.account.id + ':' + f.draft.id + '"]')).toBeTruthy());
    fireEvent.click(view.container.querySelector('[data-row-key="requested_followup:' + f.account.id + ':' + f.draft.id + '"]')!);
    const detail = within(view.container.querySelector('.native-desk__detail')! as HTMLElement);
    expect(detail.getByRole('heading', { name: 'nora@fixture.invalid' })).toBeTruthy();
    expect(detail.queryByRole('heading', { name: 'Nora Source' })).toBeNull();
    expect(detail.getByText('Linked call contact: Nora Source')).toBeTruthy();
    expect(ui.forbidden).not.toHaveBeenCalled();
  } finally { cleanup(); f.close(); }
});

it('actual stored manual draft exposes only its pinned person while viewing stays query-only', async () => {
  const f = await createLinkedInFixture();
  try {
    const draft = f.drafts.create(f.drafts.requireStep(f.version.steps[0]!.id, 1), 'Saved local manual note');
    const ui = actualReaderUi(f), before = ui.snapshot(); f.db.raw.pragma('query_only=ON');
    const view = render(<PresentationRoot><NativeDeskRoute onOpenImport={(): void => undefined} firstUse={ui.firstUse} api={ui.api} onOpenLead={ui.forbidden} /></PresentationRoot>);
    await waitFor(() => expect(view.container.querySelector('[data-row-key="manual_linkedin:' + f.account.id + ':' + draft.id + '"]')).toBeTruthy());
    fireEvent.click(view.container.querySelector('[data-row-key="manual_linkedin:' + f.account.id + ':' + draft.id + '"]')!);
    const detail = within(view.container.querySelector('.native-desk__detail')! as HTMLElement);
    expect(detail.getByRole('heading', { name: 'Fictional Person' })).toBeTruthy();
    expect(screen.getByDisplayValue(draft.body)).toBeTruthy();
    expect(ui.forbidden).not.toHaveBeenCalled(); expect(ui.snapshot()).toEqual(before);
  } finally { cleanup(); f.close(); }
});
