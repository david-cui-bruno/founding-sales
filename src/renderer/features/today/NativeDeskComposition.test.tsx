import { PresentationRoot } from '../../app/PresentationRoot';
// @vitest-environment jsdom
import { randomUUID } from 'node:crypto';
import { act, cleanup, fireEvent, render as testingRender, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createLinkedInFixture } from '../../../../tests/fixtures/linkedInWorkspace';
import { requestedFollowupFixture } from '../../../../tests/fixtures/requestedFollowup';
import { createDomainServices } from '../../../main/domain/createDomainServices';
import { DelegationRepository } from '../../../main/delegation/delegationRepository';
import { LinkedInService } from '../../../main/linkedin/linkedInService';
import type { ExecutionClient } from '../../../main/delegation/executionClient';
import { ownerCommandSchema } from '../../../shared/contracts/ownerCommandContract';
import type { DelegationCommand } from '../../../shared/contracts/delegationContract';
import type { AccountReplyDraft, ThreadProjection } from '../../../shared/contracts/mailThreadContract';
import { NativeDeskRoute } from './NativeDeskRoute';
import { configuredFixtureStatus, nativeDeskFixture } from './nativeDesk.fixture';
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function fixture() {
  const f = await createLinkedInFixture();
  f.db.raw.prepare("INSERT INTO workspace_workflow_state VALUES(1,'meeting_first',1,?)").run(f.now);
  const repository = new DelegationRepository({ database: f.db, workspaceId: f.workspaceId, clock: f.clock });
  repository.initializeLocalAuthority(f.account.id);
  const delegate = randomUUID();
  repository.queueCommand({ commandId: delegate, workspaceId: f.workspaceId, accountId: f.account.id, expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'delegate', payload: { delegationId: 'fixture', approvedAt: f.now } });
  repository.applyWorkerEvent({ id: randomUUID(), workspaceId: f.workspaceId, accountId: f.account.id, authorityGeneration: 1, aggregateVersion: 1, kind: 'authority.changed', payload: { authority: { accountId: f.account.id, owner: 'worker', generation: 1, state: 'active' }, receipt: { commandId: delegate, status: 'applied', authorityGeneration: 1, aggregateVersion: 1, reason: null } } });
  const services = createDomainServices({ database: f.db, clock: f.clock, ids: { next: () => { throw Error('Read allocated ID'); } }, expectedWorkspaceId: f.workspaceId });
  const read = () => services.daily.get();
  const ui = nativeDeskFixture(read());
  ui.setConfiguration({ ...configuredFixtureStatus(), workspaceId: f.workspaceId });
  ui.api.daily.get = vi.fn(async () => {
    const before = f.db.raw.prepare('SELECT total_changes() AS n').get();
    const result = read();
    expect(f.db.raw.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    return result;
  });
  const forbidden = vi.fn(async () => { throw Error('Unexpected command boundary'); });
  Object.assign(ui.api.linkedin, { prepare: forbidden, get: forbidden, recover: forbidden, save: forbidden, begin: forbidden, copy: forbidden, open: forbidden, reportOutcome: forbidden });
  vi.spyOn(ui.api.delegation, 'sync').mockImplementation(forbidden);
  return { ...f, ...ui, read, repository, forbidden };
}
function envelope(f: Awaited<ReturnType<typeof fixture>>, commandId: string) {
  return { commandId, workspaceId: f.workspaceId, accountId: f.account.id, expectedAuthorityGeneration: 1, expectedVersion: f.repository.executionVersion(f.account.id)! };
}
function rejectCommand(f: Awaited<ReturnType<typeof fixture>>, command: DelegationCommand) {
  expect(f.repository.applyWorkerEvent({ id: randomUUID(), workspaceId: f.workspaceId, accountId: f.account.id, authorityGeneration: 1, aggregateVersion: command.expectedVersion + 1, kind: 'authority.changed', payload: { authority: f.repository.authority(f.account.id)!, receipt: { commandId: command.commandId, status: 'rejected', authorityGeneration: 1, aggregateVersion: command.expectedVersion + 1, reason: 'Fixture owner rejection' } } })).toBe('applied');
}
it.each(['applied', 'rejected'] as const)('real pending manual report reconciles %s without changing retained command', async status => {
  const f = await fixture();
  try {
    const draft = f.drafts.create(f.drafts.requireStep(f.version.steps[0].id, 1), 'Saved manual text');
    const beginId = randomUUID();
    const approval = f.drafts.approve({ commandId: beginId, draftId: draft.id, expectedRevision: 1 });
    f.repository.queueCommand(ownerCommandSchema.parse({ ...envelope(f, beginId), kind: 'prepare-manual', payload: approval.binding }));
    const handoff = { ...approval.binding, handoffId: 'fixture-handoff', expiresAt: '2099-09-10T12:00:00.000Z' };
    expect(f.repository.applyWorkerEvent({ id: randomUUID(), workspaceId: f.workspaceId, accountId: f.account.id, authorityGeneration: 1, aggregateVersion: 2, kind: 'manual.handoff', payload: handoff, receipt: { commandId: beginId, status: 'applied', authorityGeneration: 1, aggregateVersion: 2, reason: null } })).toBe('applied');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(f.now));
    const full = f.repository.getManualHandoff(handoff.handoffId)!;
    const { consumedAt: _, ...stored } = full; void _;
    f.repository.consumeManualHandoff(stored, () => undefined);
    f.clock.now = () => f.now;
    const client = { submit: async (command: DelegationCommand) => f.repository.queueCommand(command), sync: async () => ({ applied: 0, gaps: 0, cursor: null as null, ownerFresh: false }) } as unknown as ExecutionClient;
    const service = new LinkedInService({ repository: f.drafts, owner: { repository: f.repository, client } });
    f.api.linkedin.reportOutcome = vi.fn(input => service.reportOutcome(input));
    render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manual LinkedIn · Fictional Campaign PM' }));
    fireEvent.change(screen.getByLabelText('Manual outcome'), { target: { value: 'not_sent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record outcome' }));
    await waitFor(() => expect(f.repository.pendingCommands()).toHaveLength(1));
    const command = f.repository.pendingCommands()[0];
    const retained = structuredClone(command);
    expect(command.kind).toBe('complete-manual');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByRole('button', { name: 'Reconcile queued commands' });
    expect((screen.getByRole('button', { name: 'Retry retained outcome' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Copy note' }) as HTMLButtonElement).disabled).toBe(true);
    let finish!: () => void;
    vi.spyOn(f.api.delegation, 'sync').mockImplementation(() => new Promise(resolve => { finish = () => {
      if (status === 'rejected') rejectCommand(f, command);
      else {
        if (command.kind !== 'complete-manual') throw Error('fixture');
        expect(f.repository.applyWorkerEvent({ id: randomUUID(), workspaceId: f.workspaceId, accountId: f.account.id, authorityGeneration: 1, aggregateVersion: 3, kind: 'manual.outcome', payload: command.payload.outcome, receipt: { commandId: command.commandId, status, authorityGeneration: 1, aggregateVersion: 3, reason: null } })).toBe('applied');
      }
      resolve({ applied: 1, gaps: 0, cursor: null, ownerFresh: true });
    }; }));
    const before = vi.mocked(f.api.daily.get).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile queued commands' }));
    expect(f.api.daily.get).toHaveBeenCalledTimes(before);
    await act(async () => finish());
    await waitFor(() => expect(f.api.daily.get).toHaveBeenCalledTimes(before + 1));
    expect(f.read().ownerStatus[0].pendingCommands).toEqual([]);
    expect(f.repository.getCommand(command.commandId)).toEqual(retained);
    expect(f.repository.commandStatus(command.commandId)?.status).toBe(status);
    expect(f.api.linkedin.reportOutcome).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry retained outcome' }));
    await screen.findByText(`Human outcome receipt: ${status}.`);
    expect(f.api.linkedin.reportOutcome).toHaveBeenCalledTimes(2);
    const reports = vi.mocked(f.api.linkedin.reportOutcome).mock.calls;
    expect(reports[1][0]).toEqual(reports[0][0]);
    expect(f.repository.getCommand(command.commandId)).toEqual(retained);
    expect(f.forbidden).not.toHaveBeenCalled();
  } finally { cleanup(); f.close(); }
});
it.each(['applied', 'rejected'] as const)('lost requested approval response reconciles %s from real saved outbox', async status => {
  const f = await fixture();
  try {
    let draft = requestedFollowupFixture(f.account.id, 3).draft;
    const persist = () => f.db.raw.prepare('INSERT OR REPLACE INTO delegated_requested_followup_drafts VALUES(?,?,?,?,?,?,?,?)').run(f.workspaceId, f.account.id, draft.id, draft.revision, draft.contextRevision, JSON.stringify(draft), null, f.now);
    persist();
    vi.spyOn(f.api.delegation, 'editRequestedFollowup').mockImplementation(async input => { draft = { ...draft, revision: draft.revision + 1, subject: input.subject, body: input.body }; persist(); return { draft, stale: false, approval: null }; });
    vi.spyOn(f.api.delegation, 'approveRequestedFollowup').mockImplementation(async input => {
      f.repository.queueCommand(ownerCommandSchema.parse({ ...envelope(f, randomUUID()), kind: 'approve-requested-followup', payload: input }));
      throw Error('Lost response after durable queue');
    });
    render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Email · Fictional Campaign PM' }));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Approval expiry'), { target: { value: '2099-09-10T12:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve email' }));
    await waitFor(() => expect(f.repository.pendingCommands()).toHaveLength(1));
    const command = f.repository.pendingCommands()[0];
    const retained = structuredClone(command);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByRole('button', { name: 'Reconcile queued commands' });
    expect((screen.getByRole('button', { name: 'Owner preflight' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Approve email' }) as HTMLButtonElement).disabled).toBe(true);
    vi.spyOn(f.api.delegation, 'sync').mockImplementation(async () => {
      if (status === 'rejected') rejectCommand(f, command);
      else {
        if (command.kind !== 'approve-requested-followup') throw Error('fixture');
        expect(f.repository.applyWorkerEvent({ id: randomUUID(), workspaceId: f.workspaceId, accountId: f.account.id, authorityGeneration: 1, aggregateVersion: 2, kind: 'requested_followup.status', payload: { commandId: command.commandId, draftId: draft.id, status: { state: 'pending_preflight', receipt: { commandId: command.commandId, status: 'applied', authorityGeneration: 1, aggregateVersion: 2, reason: null }, intentCommandId: null, reason: null } } })).toBe('applied');
      }
      return { applied: 1, gaps: 0, cursor: null, ownerFresh: true };
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile queued commands' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reconcile queued commands' })).toBeNull());
    expect(f.repository.getCommand(command.commandId)).toEqual(retained);
    expect(f.api.delegation.approveRequestedFollowup).toHaveBeenCalledTimes(1);
    const saved = f.read().answers.find(a => a.kind === 'requested_followup');
    expect(saved?.kind === 'requested_followup' && saved.approval?.receipt.status).toBe(status);
    expect(f.forbidden).not.toHaveBeenCalled();
  } finally { cleanup(); f.close(); }
});
function saveReply(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const draft: AccountReplyDraft = { id, accountId: f.account.id, threadId: 'thread', mailboxSubject: 'mailbox', threadRevision: 1, contextRevision: 'context', revision: 1, recipient: 'person@example.invalid', sender: 'founder@example.invalid', subject: 'Re: Reply', body: `Saved body ${id}`, evidenceIds: ['message'], generation: 'edited', updatedAt: f.now };
  f.db.raw.prepare('INSERT INTO delegated_reply_drafts VALUES(?,?,?,?,?,?,?,?,?)').run(f.workspaceId, f.account.id, id, draft.threadId, 1, 1, draft.contextRevision, JSON.stringify(draft), f.now);
}
function saveThread(f: Awaited<ReturnType<typeof fixture>>) {
  const thread: ThreadProjection = { thread: { accountId: f.account.id, mailboxSubject: 'mailbox', provider: 'gmail', providerThreadId: 'thread', messages: [{ id: 'message', threadId: 'thread', rfcMessageId: null, references: [], from: ['person@example.invalid'], to: ['founder@example.invalid'], cc: [], date: f.now, subject: 'Reply', bodyParts: [{ mimeType: 'text/plain', text: 'Tell me more', truncated: false }] }] }, revision: 1, contextRevision: 'context', signals: [{ kind: 'substantive', evidence: [{ messageId: 'message', quote: 'Tell me more' }], requiresApproval: true }] };
  f.db.raw.prepare('INSERT INTO delegated_threads VALUES(?,?,?,?,?,?,?,?,?)').run(f.workspaceId, f.account.id, 'thread', 'gmail', 'thread', 1, 'context', JSON.stringify(thread), f.now);
}
it('real persisted second reply has exact detail, one selected row, keyboard and refresh identity', async () => {
  const f = await fixture();
  try {
    saveThread(f); saveReply(f, '1'); saveReply(f, '2');
    const error = vi.spyOn(console, 'error');
    render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
    const rows = await screen.findAllByRole('button', { name: 'Reply · Fictional Campaign PM' });
    expect(rows).toHaveLength(2);
    expect(rows[0].dataset.rowKey).not.toBe(rows[1].dataset.rowKey);
    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1], { key: 'Enter' });
    expect(screen.getByText('Saved body 2')).toBeTruthy();
    expect(screen.queryByText('Saved body 1')).toBeNull();
    expect(document.querySelectorAll('[data-row-key][aria-current="true"]')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(f.api.daily.get).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Saved body 2')).toBeTruthy();
    expect(rows[1].getAttribute('aria-current')).toBe('true');
    fireEvent.keyDown(rows[1], { key: 'Escape' });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.click(rows[1]);
    expect(screen.getByText('Saved body 2')).toBeTruthy();
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
    expect(f.forbidden).not.toHaveBeenCalled();
  } finally { cleanup(); f.close(); }
});
it('real no-draft placeholder transitions to a separately selectable saved reply without aliasing', async () => {
  const f = await fixture();
  try {
    saveThread(f);
    render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
    const row = await screen.findByRole('button', { name: 'Reply · Fictional Campaign PM' });
    const placeholderKey = row.dataset.rowKey;
    fireEvent.click(row);
    saveReply(f, 'no-draft');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(f.api.daily.get).toHaveBeenCalledTimes(2));
    const saved = screen.getByRole('button', { name: 'Reply · Fictional Campaign PM' });
    expect(saved.dataset.rowKey).not.toBe(placeholderKey);
    expect(saved.getAttribute('aria-current')).toBeNull();
    fireEvent.click(saved);
    expect(screen.getByText('Saved body no-draft')).toBeTruthy();
    expect(document.querySelectorAll('[data-row-key][aria-current="true"]')).toHaveLength(1);
    expect(f.forbidden).not.toHaveBeenCalled();
  } finally { cleanup(); f.close(); }
});
it.each(['paused', 'revoked', 'foreign', 'failure', 'unrelated'] as const)('real outbox retains new-work protection under %s reconciliation', async condition => {
  const f = await fixture();
  try {
    const draft = requestedFollowupFixture(f.account.id, 3).draft;
    f.db.raw.prepare('INSERT INTO delegated_requested_followup_drafts VALUES(?,?,?,?,?,?,?,?)').run(f.workspaceId, f.account.id, draft.id, draft.revision, draft.contextRevision, JSON.stringify(draft), null, f.now);
    const command = ownerCommandSchema.parse({ ...envelope(f, randomUUID()), kind: 'approve-requested-followup', payload: { draft, expectedRemoteDraftRevision: 1, approvalId: 'approval', actionId: 'action', intentCommandId: randomUUID(), request: { statement: 'recipient_requested_information_by_email', recipient: draft.recipient }, expiresAt: '2099-09-10T12:00:00.000Z' } });
    f.repository.queueCommand(command);
    if (condition === 'paused' || condition === 'foreign') f.setConfiguration({ ...configuredFixtureStatus(), workspaceId: condition === 'foreign' ? 'other' : f.workspaceId, state: condition === 'paused' ? 'paused' : 'active' });
    if (condition === 'revoked') f.db.raw.prepare("UPDATE delegated_authorities SET state='revoked' WHERE account_id=?").run(f.account.id);
    if (condition === 'unrelated') f.repository.queueCommand({ ...envelope(f, randomUUID()), kind: 'pause', payload: { reason: 'Unrelated retained stop' } });
    vi.spyOn(f.api.delegation, 'sync').mockImplementation(async () => {
      if (condition === 'failure') throw Error('Offline');
      rejectCommand(f, command);
      return { applied: 100, gaps: 0, cursor: null, ownerFresh: true };
    });
    render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} onOpenLead={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Email · Fictional Campaign PM' }));
    fireEvent.focus(window);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(f.api.daily.get).toHaveBeenCalledTimes(3));
    expect(f.api.delegation.sync).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Owner preflight' }) as HTMLButtonElement).disabled).toBe(true);
    const sync = screen.getByRole('button', { name: 'Reconcile queued commands' }) as HTMLButtonElement;
    expect(sync.disabled).toBe(!['failure', 'unrelated'].includes(condition));
    fireEvent.click(sync);
    if (condition === 'failure') await screen.findByText(/Reconciliation unavailable/);
    else if (condition === 'unrelated') await waitFor(() => expect(f.api.daily.get).toHaveBeenCalledTimes(4));
    else expect(f.api.delegation.sync).not.toHaveBeenCalled();
    expect(f.read().ownerStatus[0].pendingCommands).toHaveLength(1);
    expect((screen.getByRole('button', { name: 'Owner preflight' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Approve email' }) as HTMLButtonElement).disabled).toBe(true);
    expect(f.repository.getCommand(command.commandId)).toEqual(command);
    expect(f.forbidden).not.toHaveBeenCalled();
  } finally { cleanup(); f.close(); }
});

const render = (ui: Parameters<typeof testingRender>[0], options?: Parameters<typeof testingRender>[1]) => testingRender(ui, { wrapper: PresentationRoot, ...options });

Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
