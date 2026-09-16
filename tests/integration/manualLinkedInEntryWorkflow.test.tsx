// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createLinkedInFixture } from '../fixtures/linkedInWorkspace';
import { LinkedInService } from '../../src/main/linkedin/linkedInService';
import { createLinkedInDraftProvider } from '../../src/main/linkedin/linkedInDraftProvider';
import { ExecutionClient } from '../../src/main/delegation/executionClient';
import { SqlDelegationTransport } from '../../src/main/delegation/delegationSync';
import { accountFingerprint } from '../../src/main/domain/accounts/accountEvidence';
import type { DelegationCommand, WorkerEvent, CommandReceipt } from '../../src/shared/contracts/delegationContract';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { PresentationRoot } from '../../src/renderer/app/PresentationRoot';
import { NativeDeskRoute } from '../../src/renderer/features/today/NativeDeskRoute';
import { ManualLinkedInPreparation } from '../../src/renderer/features/linkedin/ManualLinkedInPreparation';
import { configuredFixtureStatus, nativeDeskFixture } from '../../src/renderer/features/today/nativeDesk.fixture';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Accepted checkpoint: existing approved enrollment, not a clean-workspace launch.
// The initial RED renders the real route, without importing the proposed component.
async function fixture() {
  const f = await createLinkedInFixture('https://www.linkedin.com/in/fictional-business', true);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(f.now));
  vi.stubGlobal('fetch', vi.fn(async () => { throw Error('Real network forbidden'); }));
  f.db.raw.prepare("INSERT INTO workspace_workflow_state VALUES(1,'meeting_first',1,?)").run(f.now);
  const owner = new DelegationRepository({ database: f.db, workspaceId: f.workspaceId, clock: f.clock });
  owner.initializeLocalAuthority(f.account.id);
  const commandId = randomUUID();
  owner.queueCommand({ commandId, workspaceId: f.workspaceId, accountId: f.account.id, expectedAuthorityGeneration: 0,
    expectedVersion: 0, kind: 'delegate', payload: { delegationId: 'fictional-existing-owner', approvedAt: f.now } });
  owner.applyWorkerEvent({ id: randomUUID(), workspaceId: f.workspaceId, accountId: f.account.id, authorityGeneration: 1,
    aggregateVersion: 1, kind: 'authority.changed', payload: { authority: { accountId: f.account.id, owner: 'worker', generation: 1, state: 'active' },
      receipt: { commandId, status: 'applied', authorityGeneration: 1, aggregateVersion: 1, reason: null } } });
  const services = createDomainServices({ database: f.db, clock: f.clock, ids: { next: randomUUID }, expectedWorkspaceId: f.workspaceId });
  const ui = nativeDeskFixture(services.daily.get());
  ui.setConfiguration({ ...configuredFixtureStatus(), workspaceId: f.workspaceId });
  ui.api.daily.get = vi.fn(async () => services.daily.get());
  const forbidden = vi.fn(async (): Promise<never> => { throw Error('Unrequested outbound operation'); });
  vi.spyOn(ui.api.delegation, 'sync').mockImplementation(forbidden);
  vi.spyOn(ui.api.delegation, 'submit').mockImplementation(forbidden);
  Object.assign(ui.api.linkedin, { prepare: forbidden, begin: forbidden, open: forbidden, copy: forbidden, reportOutcome: forbidden });
  const modelFetch = vi.fn(async () => Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: JSON.stringify({ body: 'Fictional editable LinkedIn note', evidenceIds: [] }) }] }] }));
  const provider = createLinkedInDraftProvider({ credentials: { load: async () => ({ model: { apiKey: 'fictional-key', model: 'fictional-model' } }) }, fetch: modelFetch });
  const commands: DelegationCommand[] = [], events: WorkerEvent[] = [];
  let online = true;
  // Only the remote HTTP boundary is fictional. Existing service/outbox, event parsing,
  // SQL projection and one-shot manual handoff consumption execute normally.
  const http: typeof fetch = async (_url, init) => {
    if (!online) throw Error('Fictional owner offline');
    if (init?.method === 'POST') {
      const command = JSON.parse(String(init.body)) as DelegationCommand;
      if (!['prepare-manual', 'complete-manual'].includes(command.kind)) throw Error('Unexpected owner command');
      if (!commands.some(value => value.commandId === command.commandId)) {
        commands.push(command);
        const receipt: CommandReceipt = { commandId: command.commandId, status: 'applied', authorityGeneration: 1, aggregateVersion: events.length + 2, reason: null };
        const base = { id: randomUUID(), workspaceId: f.workspaceId, accountId: f.account.id, authorityGeneration: 1, aggregateVersion: receipt.aggregateVersion };
        if (command.kind === 'prepare-manual') events.push({ ...base, kind: 'manual.handoff', payload: { ...command.payload, handoffId: randomUUID(), expiresAt: new Date(Date.parse(f.now) + 60000).toISOString() }, receipt });
        if (command.kind === 'complete-manual') events.push({ ...base, kind: 'manual.outcome', payload: command.payload.outcome, receipt });
      }
      const event = events.find(value => 'receipt' in value && value.receipt.commandId === command.commandId)!;
      return Response.json('receipt' in event ? event.receipt : null);
    }
    const cursor = `${accountFingerprint(f.workspaceId)}:${events.length}`;
    return Response.json({ events, nextCursor: cursor, headCursor: cursor, complete: true });
  };
  const transport = new SqlDelegationTransport({ database: f.db, workspaceId: f.workspaceId, pairingId: 'fictional-pairing', clock: f.clock });
  const client = new ExecutionClient({ repository: owner, transport, pairing: { endpoint: 'https://owner.example.invalid', workspaceId: f.workspaceId, credential: 'a'.repeat(43) }, fetch: http });
  const openExternal = vi.fn(async () => undefined), writeText = vi.fn();
  const service = new LinkedInService({ repository: f.drafts, provider, owner: { repository: owner, client }, shell: { openExternal }, clipboard: { writeText } });
  const connect = () => {
    ui.api.linkedin.prepare = vi.fn(input => service.prepare(input));
    ui.api.linkedin.save = vi.fn(input => service.save(input));
    ui.api.linkedin.get = vi.fn(input => service.get(input));
    ui.api.linkedin.recover = vi.fn(input => service.recover(input));
    ui.api.linkedin.begin = vi.fn(input => service.begin(input));
    ui.api.linkedin.copy = vi.fn(input => service.copy(input));
    ui.api.linkedin.open = vi.fn(input => service.open(input));
    ui.api.linkedin.reportOutcome = vi.fn(input => service.reportOutcome(input));
  };
  return { ...f, ...ui, owner, services, forbidden, modelFetch, commands, connect, service, openExternal, writeText, setOnline: (value: boolean) => { online = value; } };
}

it('offers explicit LinkedIn preparation from an existing enrolled campaign in the real route', async () => {
  const f = await fixture();
  try {
    render(<PresentationRoot><NativeDeskRoute api={f.api} firstUse={f.firstUse} surface="campaigns" onOpenLead={vi.fn()} onOpenImport={vi.fn()} /></PresentationRoot>);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(f.version.campaignId) }));
    expect(f.services.daily.get().answers.filter(answer => answer.kind === 'manual_linkedin')).toHaveLength(0);
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Prepare LinkedIn note' })).toBeTruthy();
  } finally { f.close(); }
});

it('connects the preparation panel to real saved projection without any owner command', async () => {
  const f = await fixture(); f.connect();
  try {
    const snapshot = f.services.daily.get();
    const campaign = snapshot.campaigns.find(value => value.version.id === f.version.id)!;
    render(<ManualLinkedInPreparation api={f.api} snapshot={snapshot} campaign={campaign}
      config={{ ...configuredFixtureStatus(), workspaceId: f.workspaceId }} readError={false} onRefresh={vi.fn()} />);
    expect(f.modelFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare LinkedIn note' }));
    expect((await screen.findByLabelText('LinkedIn note') as HTMLTextAreaElement).value).toBe('Fictional editable LinkedIn note');
    expect(f.modelFetch).toHaveBeenCalledTimes(1);
    expect(f.commands).toEqual([]); expect(f.forbidden).not.toHaveBeenCalled();
  } finally { cleanup(); f.service.dispose(); f.close(); }
});

it('prepares once, preserves the human edit, and records only the explicitly reported manual outcome', async () => {
  const f = await fixture(); f.connect();
  try {
    render(<PresentationRoot><NativeDeskRoute api={f.api} firstUse={f.firstUse} surface="campaigns" onOpenLead={vi.fn()} onOpenImport={vi.fn()} /></PresentationRoot>);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(f.version.campaignId) }));
    expect(f.modelFetch).not.toHaveBeenCalled(); expect(f.commands).toEqual([]);
    const prepare = await screen.findByRole<HTMLButtonElement>('button', { name: 'Prepare LinkedIn note' });
    await waitFor(() => expect(prepare.disabled).toBe(false));
    fireEvent.click(prepare);
    await screen.findByLabelText('LinkedIn note');
    expect(f.modelFetch).toHaveBeenCalledTimes(1);
    expect(f.commands).toEqual([]); expect(f.openExternal).not.toHaveBeenCalled(); expect(f.writeText).not.toHaveBeenCalled();
    const draft = f.services.daily.get().answers.find(answer => answer.kind === 'manual_linkedin')!;
    if (draft.kind !== 'manual_linkedin') throw Error('Missing LinkedIn draft');
    expect(draft.draft).toMatchObject({ enrollmentId: f.enrollment.id, stepId: f.version.steps[0].id, state: 'draft' });
    await waitFor(() => expect(screen.getByLabelText<HTMLTextAreaElement>('LinkedIn note').readOnly).toBe(false));
    fireEvent.change(screen.getByLabelText('LinkedIn note'), { target: { value: 'Human-reviewed fictional note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(f.drafts.requireRevision(draft.draft.id, 2).body).toBe('Human-reviewed fictional note'));
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(f.version.campaignId) }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open saved LinkedIn note' }));
    expect((await screen.findByLabelText('LinkedIn note') as HTMLTextAreaElement).value).toBe('Human-reviewed fictional note');
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Begin manual step' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Begin manual step' }));
    await screen.findByText('Manual handoff started. Opening and copying do not send.');
    fireEvent.click(screen.getByRole('button', { name: 'Copy note' }));
    await screen.findByText('Note copied. No outcome recorded.');
    fireEvent.click(screen.getByRole('button', { name: 'Open LinkedIn' }));
    await screen.findByText('LinkedIn opened. No outcome recorded.');
    expect(f.commands.map(command => command.kind)).toEqual(['prepare-manual']);
    expect(f.writeText).toHaveBeenCalledWith('Human-reviewed fictional note');
    expect(f.openExternal).toHaveBeenCalledWith('https://www.linkedin.com/in/fictional-business');
    expect(f.db.raw.prepare('SELECT count(*) AS n FROM delegated_manual_outcomes').get()).toEqual({ n: 0 });
    f.setOnline(false);
    fireEvent.change(screen.getByLabelText('Manual outcome'), { target: { value: 'human_reported_sent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record outcome' }));
    await screen.findByText('Human outcome receipt: pending.');
    const pending = f.owner.pendingCommands()[0];
    expect(pending).toMatchObject({ kind: 'complete-manual', payload: { outcome: { actionId: `${draft.draft.id}:2`, outcome: 'human_reported_sent' } } });
    expect(f.db.raw.prepare('SELECT count(*) AS n FROM delegated_manual_outcomes').get()).toEqual({ n: 0 });
    f.setOnline(true);
    fireEvent.click(screen.getByRole('button', { name: 'Retry retained outcome' }));
    await screen.findByText('Human outcome receipt: applied.');
    expect(f.owner.getCommand(pending.commandId)).toEqual(pending);
    expect(f.db.raw.prepare('SELECT count(*) AS n FROM delegated_manual_outcomes').get()).toEqual({ n: 1 });
    expect(f.modelFetch).toHaveBeenCalledTimes(1);
    expect(f.forbidden).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally { cleanup(); f.service.dispose(); f.close(); }
});

it('recovers a saved draft after a lost prepare response and a fresh bridge without regenerating', async () => {
  const f = await fixture(); f.connect();
  try {
    f.api.linkedin.prepare = vi.fn(async input => { await f.service.prepare(input); throw Error('Lost post-save response'); });
    const view = render(<PresentationRoot><NativeDeskRoute api={f.api} firstUse={f.firstUse} surface="campaigns" onOpenLead={vi.fn()} onOpenImport={vi.fn()} /></PresentationRoot>);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(f.version.campaignId) }));
    const prepare = await screen.findByRole<HTMLButtonElement>('button', { name: 'Prepare LinkedIn note' });
    await waitFor(() => expect(prepare.disabled).toBe(false)); fireEvent.click(prepare);
    await screen.findByRole('alert');
    const saved = f.services.daily.get().answers.find(answer => answer.kind === 'manual_linkedin')!;
    if (saved.kind !== 'manual_linkedin') throw Error('Missing durable draft');
    expect(f.modelFetch).toHaveBeenCalledTimes(1); view.unmount();
    const freshPrepare = vi.fn((input: Parameters<typeof f.service.prepare>[0]) => f.service.prepare(input));
    const api = { ...f.api, linkedin: { ...f.api.linkedin, prepare: freshPrepare } };
    render(<PresentationRoot><NativeDeskRoute api={api} firstUse={f.firstUse} surface="campaigns" onOpenLead={vi.fn()} onOpenImport={vi.fn()} /></PresentationRoot>);
    // The route may retain selection, but never prepares on remount.
    if (!screen.queryByRole('button', { name: 'Open saved LinkedIn note' })) fireEvent.click(await screen.findByRole('button', { name: new RegExp(f.version.campaignId) }));
    const reopen = await screen.findByRole<HTMLButtonElement>('button', { name: 'Open saved LinkedIn note' });
    await waitFor(() => expect(reopen.disabled).toBe(false)); fireEvent.click(reopen);
    expect((await screen.findByLabelText('LinkedIn note') as HTMLTextAreaElement).value).toBe(saved.draft.body);
    expect(freshPrepare).not.toHaveBeenCalled(); expect(f.modelFetch).toHaveBeenCalledTimes(1);
    expect(f.commands).toEqual([]); expect(f.forbidden).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally { cleanup(); f.service.dispose(); f.close(); }
});

it('allows an explicit new generation after a real pre-save provider failure and saved-projection recovery', async () => {
  const f = await fixture(); f.connect();
  try {
    f.modelFetch.mockRejectedValueOnce(Error('Fictional provider not configured'));
    render(<PresentationRoot><NativeDeskRoute api={f.api} firstUse={f.firstUse} surface="campaigns" onOpenLead={vi.fn()} onOpenImport={vi.fn()} /></PresentationRoot>);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(f.version.campaignId) }));
    const prepare = await screen.findByRole<HTMLButtonElement>('button', { name: 'Prepare LinkedIn note' });
    await waitFor(() => expect(prepare.disabled).toBe(false)); fireEvent.click(prepare);
    await screen.findByRole('alert');
    expect(f.modelFetch).toHaveBeenCalledTimes(1);
    expect(f.db.raw.prepare('SELECT count(*) AS n FROM manual_linkedin_drafts').get()).toEqual({ n: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Recover saved LinkedIn note' }));
    const retry = await screen.findByRole('button', { name: 'Retry LinkedIn note generation' });
    expect(f.modelFetch).toHaveBeenCalledTimes(1);
    fireEvent.click(retry);
    await screen.findByLabelText('LinkedIn note');
    expect(f.modelFetch).toHaveBeenCalledTimes(2);
    expect(f.db.raw.prepare('SELECT count(*) AS n FROM manual_linkedin_drafts').get()).toEqual({ n: 1 });
    expect(f.commands).toEqual([]); expect(f.forbidden).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally { cleanup(); f.service.dispose(); f.close(); }
});
