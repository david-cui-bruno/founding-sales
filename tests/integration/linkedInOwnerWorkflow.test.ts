import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createLinkedInFixture } from '../fixtures/linkedInWorkspace';
import { LinkedInService } from '../../src/main/linkedin/linkedInService';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { ExecutionClient } from '../../src/main/delegation/executionClient';
import { SqlDelegationTransport } from '../../src/main/delegation/delegationSync';
import { accountFingerprint } from '../../src/main/domain/accounts/accountEvidence';
import type { CommandReceipt, DelegationCommand, WorkerEvent } from '../../src/shared/contracts/delegationContract';

async function ownerFixture() {
  const f = await createLinkedInFixture();
  const repository = new DelegationRepository({ database: f.db, workspaceId: f.workspaceId, clock: f.clock });
  repository.initializeLocalAuthority(f.account.id);
  const events: WorkerEvent[] = []; const commands: DelegationCommand[] = [];
  let online = true;
  // Fictional remote boundary only. Real HTTP client, durable outbox, strict event parser,
  // SQL projector, token consumer and D2 service execute. Not live owner acceptance.
  const http: typeof fetch = async (_url, init) => {
    if (!online) throw new Error('fictional offline');
    if (init?.method === 'POST') {
      const command = JSON.parse(String(init.body)) as DelegationCommand;
      if (!commands.some(c => c.commandId === command.commandId)) {
        commands.push(command);
        const receipt: CommandReceipt = { commandId: command.commandId, status: 'applied' as const, authorityGeneration: 1, aggregateVersion: events.length + 1, reason: null };
        const base = { id: randomUUID(), workspaceId: f.workspaceId, accountId: f.account.id, authorityGeneration: 1, aggregateVersion: receipt.aggregateVersion };
        if (command.kind === 'delegate') events.push({ ...base, kind: 'authority.changed', payload: { authority: { accountId: f.account.id, owner: 'worker', generation: 1, state: 'active' }, receipt } });
        if (command.kind === 'prepare-manual') events.push({ ...base, kind: 'manual.handoff', payload: { ...command.payload, handoffId: randomUUID(), expiresAt: '2026-09-09T12:10:00.000Z' }, receipt });
        if (command.kind === 'complete-manual') events.push({ ...base, kind: 'manual.outcome', payload: command.payload.outcome, receipt });
      }
      const event = events.find(event => ('receipt' in event ? event.receipt.commandId : event.kind === 'authority.changed' ? event.payload.receipt.commandId : '') === command.commandId)!;
      return Response.json('receipt' in event ? event.receipt : event.kind === 'authority.changed' ? event.payload.receipt : null);
    }
    const cursor = `${accountFingerprint(f.workspaceId)}:${events.length}`;
    return Response.json({ events, nextCursor: cursor, headCursor: cursor, complete: true });
  };
  const transport = new SqlDelegationTransport({ database: f.db, workspaceId: f.workspaceId, pairingId: 'fictional-pairing', clock: f.clock });
  const client = new ExecutionClient({ repository, transport, pairing: { endpoint: 'https://worker.example.test', workspaceId: f.workspaceId, credential: 'a'.repeat(43) }, fetch: http });
  await client.submit({ commandId: randomUUID(), workspaceId: f.workspaceId, accountId: f.account.id, kind: 'delegate', expectedAuthorityGeneration: 0, expectedVersion: 0, payload: { delegationId: randomUUID(), approvedAt: f.now } });
  await client.sync(new AbortController().signal);
  const draft = f.drafts.create(f.drafts.requireStep(f.version.steps[0]!.id, 1), 'Reviewed');
  const service = () => new LinkedInService({ repository: f.drafts, owner: { repository, client } });
  return { ...f, repository, client, draft, service, commands, setOnline: (value: boolean) => { online = value; } };
}
describe('LinkedIn actual local owner boundary', () => {
  it('starts once, survives service restart and keeps reports pending until owner event synchronization', async () => {
    const f = await ownerFixture();
    try {
      const input = { commandId: randomUUID(), draftId: f.draft.id, expectedRevision: 1 };
      const started = await f.service().begin(input);
      expect(started).toMatchObject({ status: 'started', receipt: { status: 'applied' } });
      expect(started.handoffId).not.toBeNull();
      expect(await f.service().begin(input)).toMatchObject({ status: 'already_started', handoffId: started.handoffId });
      f.setOnline(false);
      const report = { commandId: randomUUID(), draftId: f.draft.id, expectedRevision: 1, outcome: 'human_reported_sent' as const, observedAt: f.now };
      expect(await f.service().reportOutcome(report)).toMatchObject({ receipt: { status: 'pending' } });
      expect(f.repository.commandStatus(report.commandId)?.status).toBe('pending');
      expect(f.db.raw.prepare('SELECT count(*) AS n FROM delegated_manual_outcomes').get()).toEqual({ n: 0 });
      f.setOnline(true);
      expect(await f.service().reportOutcome(report)).toMatchObject({ receipt: { status: 'applied' } });
      expect(await f.service().reportOutcome(report)).toMatchObject({ receipt: { status: 'applied' } });
      expect(f.db.raw.prepare('SELECT count(*) AS n FROM delegated_manual_outcomes').get()).toEqual({ n: 1 });
      expect(f.drafts.requireRevision(f.draft.id, 1).state).toBe('approved');
      const later = { ...report, commandId: randomUUID(), outcome: 'no_reply' as const };
      expect(await f.service().reportOutcome(later)).toMatchObject({ receipt: { status: 'applied' } });
      expect(f.commands.filter(c => c.kind === 'prepare-manual')).toHaveLength(1);
    } finally { f.close(); }
  });
  it('rejects report without begin and old revision after edit, never treats offline begin as permission', async () => {
    const f = await ownerFixture();
    try {
      const report = { commandId: randomUUID(), draftId: f.draft.id, expectedRevision: 1, outcome: 'unknown' as const, observedAt: f.now };
      await expect(f.service().reportOutcome(report)).rejects.toThrow('handoff_not_started');
      f.setOnline(false);
      const begin = { commandId: randomUUID(), draftId: f.draft.id, expectedRevision: 1 };
      expect(await f.service().begin(begin)).toMatchObject({ status: 'pending', handoffId: null });
      f.drafts.save({ draftId: f.draft.id, expectedRevision: 1, body: 'New revision' });
      f.setOnline(true);
      await expect(f.service().begin(begin)).rejects.toThrow('stale_draft');
      await expect(f.service().reportOutcome(report)).rejects.toThrow('stale_draft');
      expect(f.repository.pendingCommands().filter(c => c.kind === 'complete-manual')).toHaveLength(0);
    } finally { f.close(); }
  });
});
it('retains attributed reply evidence offline, blocks helpers while pending and rejects conflicting replay/future reports', async () => {
  const f = await ownerFixture();
  try {
    await f.service().begin({ commandId: randomUUID(), draftId: f.draft.id, expectedRevision: 1 });
    const report = { commandId: randomUUID(), draftId: f.draft.id, expectedRevision: 1, outcome: 'reply' as const, observedAt: f.now, replyText: 'Exact fictional human-supplied reply\n' };
    await expect(f.service().reportOutcome({ ...report, observedAt: '2026-09-10T12:00:00.000Z' })).rejects.toThrow('observation_time_invalid');
    f.setOnline(false);
    expect(await f.service().reportOutcome(report)).toMatchObject({ receipt: { status: 'pending' } });
    expect(f.repository.getCommand(report.commandId)).toMatchObject({ kind: 'complete-manual', payload: { outcome: { evidenceRef: report.commandId, replyText: report.replyText, outcome: 'reply' } } });
    await expect(f.service().copy({ draftId: f.draft.id, expectedRevision: 1 })).rejects.toThrow();
    await expect(f.service().reportOutcome({ ...report, replyText: 'Changed report' })).rejects.toThrow('owner_command_conflict');
    f.setOnline(true);
    expect(await f.service().reportOutcome(report)).toMatchObject({ receipt: { status: 'applied' } });
    const row = f.db.raw.prepare('SELECT outcome_json FROM delegated_manual_outcomes WHERE account_id=?').get(f.account.id) as { outcome_json: string };
    expect(JSON.parse(row.outcome_json)).toMatchObject({ outcome: 'reply', replyText: report.replyText, evidenceRef: report.commandId });
    expect(f.drafts.requireRevision(f.draft.id, 1).body).toBe('Reviewed');
  } finally { f.close(); }
});
it('records explicit unknown without inventing no-reply evidence', async () => {
  const f = await ownerFixture();
  try {
    await f.service().begin({ commandId: randomUUID(), draftId: f.draft.id, expectedRevision: 1 });
    await f.service().reportOutcome({ commandId: randomUUID(), draftId: f.draft.id, expectedRevision: 1, outcome: 'unknown', observedAt: f.now });
    const row = f.db.raw.prepare('SELECT outcome_json FROM delegated_manual_outcomes WHERE account_id=?').get(f.account.id) as { outcome_json: string };
    expect(JSON.parse(row.outcome_json).outcome).toBe('unknown');
    expect(row.outcome_json).not.toContain('no_reply');
  } finally { f.close(); }
});
it('never applies an old consumed handoff report to the newly edited draft revision', async () => {
  const f = await ownerFixture();
  try {
    const started = await f.service().begin({ commandId: randomUUID(), draftId: f.draft.id, expectedRevision: 1 });
    f.drafts.save({ draftId: f.draft.id, expectedRevision: 1, body: 'Different unsent content' });
    const report = { commandId: randomUUID(), draftId: f.draft.id, expectedRevision: 1, outcome: 'human_reported_sent' as const, observedAt: f.now };
    await expect(f.service().reportOutcome(report)).rejects.toThrow('stale_draft');
    await expect(f.service().reportOutcome({ ...report, expectedRevision: 2 })).rejects.toThrow('handoff_not_started');
    expect(f.repository.getManualHandoff(started.handoffId!)?.consumedAt).toBe(f.now);
    expect(f.db.raw.prepare('SELECT count(*) AS n FROM delegated_manual_outcomes').get()).toEqual({ n: 0 });
    expect(f.drafts.requireRevision(f.draft.id, 2)).toMatchObject({ body: 'Different unsent content', state: 'draft' });
  } finally { f.close(); }
});
