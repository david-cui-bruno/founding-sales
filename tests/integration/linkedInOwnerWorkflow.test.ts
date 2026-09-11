import { createLinkedInDraftProvider } from '../../src/main/linkedin/linkedInDraftProvider';
import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { LinkedInRepository } from '../../src/main/linkedin/linkedInRepository';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createLinkedInFixture } from '../fixtures/linkedInWorkspace';
import { LinkedInService, createRuntimeLinkedInApi } from '../../src/main/linkedin/linkedInService';
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
  const bind = (database: AppDatabase, signal?: AbortSignal) => {
    const repository = new DelegationRepository({ database, workspaceId: f.workspaceId, clock: f.clock });
    const transport = new SqlDelegationTransport({ database, workspaceId: f.workspaceId, pairingId: 'fictional-pairing', clock: f.clock });
    const client = new ExecutionClient({ repository, transport, pairing: { endpoint: 'https://worker.example.test', workspaceId: f.workspaceId, credential: 'a'.repeat(43) }, fetch: http, signal });
    return { repository, client, service: new LinkedInService({ repository: new LinkedInRepository({ ...f.deps, database }), owner: { repository, client } }) };
  };
  return { ...f, repository, client, draft, service, commands, bind, setOnline: (value: boolean) => { online = value; } };
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
      await expect(f.service().reportOutcome(report)).rejects.toThrow('handoff_not_started');
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
    expect(await f.service().reportOutcome(report)).toMatchObject({ revision: 1, receipt: { status: 'applied' } });
    await expect(f.service().reportOutcome({ ...report, expectedRevision: 2 })).rejects.toThrow('handoff_not_started');
    const later = { ...report, commandId: randomUUID(), outcome: 'reply' as const, replyText: 'Fictional reply to the old exact message' };
    f.setOnline(false); expect(await f.service().reportOutcome(later)).toMatchObject({ revision: 1, receipt: { status: 'pending' } });
    f.setOnline(true); expect(await f.service().reportOutcome(later)).toMatchObject({ revision: 1, receipt: { status: 'applied' } });
    expect(await f.service().recover({ draftId: f.draft.id, expectedRevision: 1 })).toMatchObject({ started: true, handoffId: started.handoffId });
    expect(f.repository.getManualHandoff(started.handoffId!)?.consumedAt).toBe(f.now);
    expect(f.db.raw.prepare('SELECT count(*) AS n FROM delegated_manual_outcomes').get()).toEqual({ n: 2 });
    expect(f.drafts.requireRevision(f.draft.id, 2)).toMatchObject({ body: 'Different unsent content', state: 'draft' });
  } finally { f.close(); }
});
it('recovers rejected preparation and retries unchanged approved content with a fresh envelope', async () => {
  const f = await ownerFixture();
  try {
    const first = { commandId: randomUUID(), draftId: f.draft.id, expectedRevision: 1 };
    const approval = f.drafts.approve(first);
    f.repository.queueCommand({ commandId: first.commandId, workspaceId: f.workspaceId, accountId: f.account.id, expectedAuthorityGeneration: 1, expectedVersion: 0, kind: 'prepare-manual', payload: approval.binding });
    expect(f.repository.commandStatus(first.commandId)?.status).toBe('rejected');
    const next = { ...first, commandId: randomUUID() };
    expect(await f.service().begin(next)).toMatchObject({ status: 'started' });
    expect(f.drafts.requireRevision(f.draft.id, 1).body).toBe('Reviewed');
    expect(f.commands.filter(c => c.kind === 'prepare-manual')).toHaveLength(1);
  } finally { f.close(); }
});

it.each(['approval_only', 'pending', 'started'] as const)('recovers %s original command after encrypted database close/reopen without issuing a new token', async phase => {
  const f = await ownerFixture(); let reopened: AppDatabase | undefined;
  try {
    const input = { commandId: randomUUID(), draftId: f.draft.id, expectedRevision: 1 };
    if (phase === 'approval_only') f.drafts.approve(input);
    else { f.setOnline(phase === 'started'); await f.service().begin(input); }
    closeDatabase(f.db); reopened = openDatabase({ path: f.path, key: f.key });
    const rebound = f.bind(reopened);
    const recovery = await rebound.service.recover({ draftId: input.draftId, expectedRevision: 1 });
    expect(recovery.approvalCommandId).toBe(input.commandId);
    expect(recovery.attempts).toEqual([{ commandId: input.commandId, receipt: phase === 'approval_only' ? null : expect.objectContaining({ status: phase === 'pending' ? 'pending' : 'applied' }) }]);
    expect(recovery.started).toBe(phase === 'started');
    await expect(rebound.service.begin({ ...input, commandId: randomUUID() })).rejects.toThrow('begin_attempt_unresolved');
    f.setOnline(true);
    expect(await rebound.service.begin({ ...input, commandId: recovery.approvalCommandId! })).toMatchObject({ status: phase === 'started' ? 'already_started' : 'started' });
    expect(f.commands.filter(command => command.kind === 'prepare-manual')).toHaveLength(1);
  } finally { if (reopened) closeDatabase(reopened); f.close(); }
});
it('serializes competing retry IDs through two actual encrypted connections and rolls back failed queue assertion', async () => {
  const f = await ownerFixture(); const second = openDatabase({ path: f.path, key: f.key });
  try {
    const original = { commandId: randomUUID(), draftId: f.draft.id, expectedRevision: 1 };
    const approval = f.drafts.approve(original);
    const command = { commandId: original.commandId, workspaceId: f.workspaceId, accountId: f.account.id, expectedAuthorityGeneration: 1, expectedVersion: 0, kind: 'prepare-manual' as const, payload: approval.binding };
    f.repository.queueCommand(command);
    const abortedId = randomUUID();
    expect(() => f.repository.queueCommand({ ...command, commandId: abortedId }, () => {
      expect(f.db.raw.inTransaction).toBe(true); throw new Error('assertion failed');
    })).toThrow('assertion failed');
    expect(f.repository.getCommand(abortedId)).toBeNull();
    f.setOnline(false);
    const first = { ...original, commandId: randomUUID() }; const other = { ...original, commandId: randomUUID() };
    const results = await Promise.allSettled([f.service().begin(first), f.bind(second).service.begin(other)]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(f.repository.commandStatus(first.commandId)?.status).toBe('pending');
    expect(f.repository.getCommand(other.commandId)).toBeNull();
    expect(await f.bind(second).service.recover({ draftId: f.draft.id, expectedRevision: 1 })).toMatchObject({ approvalCommandId: original.commandId, attempts: expect.arrayContaining([
      { commandId: original.commandId, receipt: expect.objectContaining({ status: 'rejected' }) }, { commandId: first.commandId, receipt: expect.objectContaining({ status: 'pending' }) }]) });
    f.setOnline(true); expect(await f.service().begin(first)).toMatchObject({ status: 'started' });
    expect(f.commands.filter(value => value.kind === 'prepare-manual')).toHaveLength(1);
  } finally { closeDatabase(second); f.close(); }
});

it('runtime API reacquires actual encrypted SQL and fresh owner per operation, deriving durable draft enrollment', async () => {
  const f = await ownerFixture(); const lifetime = new AbortController(); const signals: AbortSignal[] = [];
  let leases = 0; let live = false; let owners = 0;
  const gate = { async withDatabase<T>(run: (db: AppDatabase, signal: AbortSignal) => Promise<T>): Promise<T> {
    const database = openDatabase({ path: f.path, key: f.key }); leases++; live = true;
    try { return await run(database, lifetime.signal); } finally { live = false; closeDatabase(database); }
  } };
  try {
    const api = createRuntimeLinkedInApi({ databaseGate: gate, workspaceId: f.workspaceId, clock: f.clock,
      ownerFactory: (database, signal) => { expect(live).toBe(true); owners++; signals.push(signal); return f.bind(database, signal); },
      shell: { openExternal: async () => { expect(live).toBe(true); } }, clipboard: { writeText: () => { expect(live).toBe(true); } } });
    expect((await api.prepare({ enrollmentId: f.enrollment.id, stepId: f.draft.stepId, expectedVersion: 1 })).id).toBe(f.draft.id);
    expect((await api.get({ draftId: f.draft.id, expectedRevision: 1 })).enrollmentId).toBe(f.enrollment.id);
    await api.copy({ draftId: f.draft.id, expectedRevision: 1 }); await api.open({ draftId: f.draft.id, expectedRevision: 1 });
    await api.save({ draftId: f.draft.id, expectedRevision: 1, body: 'Scoped runtime edit' });
    const begin = { commandId: randomUUID(), draftId: f.draft.id, expectedRevision: 2 };
    expect(await api.begin(begin)).toMatchObject({ status: 'started' });
    expect(await api.recover({ draftId: f.draft.id, expectedRevision: 2 })).toMatchObject({ started: true, approvalCommandId: begin.commandId });
    expect(await api.reportOutcome({ commandId: randomUUID(), draftId: f.draft.id, expectedRevision: 2, outcome: 'human_reported_sent', observedAt: f.now })).toMatchObject({ receipt: { status: 'applied' } });
    expect(leases).toBe(8); expect(owners).toBe(8); expect(live).toBe(false); expect(signals.every(signal => signal.aborted)).toBe(true);
    await expect(api.prepare({ enrollmentId: 'wrong-enrollment', stepId: f.draft.stepId, expectedVersion: 1 })).rejects.toThrow();
    const foreign = createRuntimeLinkedInApi({ databaseGate: gate, workspaceId: 'wrong-workspace', clock: f.clock, ownerFactory: (database, signal) => f.bind(database, signal) });
    await expect(foreign.get({ draftId: f.draft.id, expectedRevision: 2 })).rejects.toThrow('draft_missing');
    lifetime.abort(); await expect(api.get({ draftId: f.draft.id, expectedRevision: 2 })).rejects.toThrow();
    expect(owners).toBe(9);
  } finally { f.close(); }
});

it('runtime lease abort cancels actual draft HTTP and rejects late completion without saving', async () => {
  const f = await createLinkedInFixture(); const lifetime = new AbortController();
  let release!: (response: Response) => void; let reached!: () => void;
  const reachedHttp = new Promise<void>(resolve => { reached = resolve; });
  const response = new Promise<Response>(resolve => { release = resolve; });
  let httpSignal: AbortSignal | null | undefined; let ownerSignal: AbortSignal | undefined; let live = false;
  const provider = createLinkedInDraftProvider({ credentials: { load: async () => ({ model: { apiKey: 'fictional-key', model: 'fictional-model' } }) },
    fetch: async (_url, init) => { expect(live).toBe(true); httpSignal = init?.signal; reached(); return response; } });
  try {
    const api = createRuntimeLinkedInApi({ workspaceId: f.workspaceId, clock: f.clock, provider,
      databaseGate: { async withDatabase<T>(run: (db: AppDatabase, signal: AbortSignal) => Promise<T>): Promise<T> {
        const database = openDatabase({ path: f.path, key: f.key }); live = true;
        try { return await run(database, lifetime.signal); } finally { live = false; closeDatabase(database); }
      } },
      ownerFactory: (database, signal) => {
        ownerSignal = signal;
        const repository = new DelegationRepository({ database, workspaceId: f.workspaceId, clock: f.clock });
        const transport = new SqlDelegationTransport({ database, workspaceId: f.workspaceId, pairingId: 'fictional-pairing', clock: f.clock });
        const client = new ExecutionClient({ repository, transport, pairing: { endpoint: 'https://worker.example.test', workspaceId: f.workspaceId, credential: 'a'.repeat(43) }, signal,
          fetch: async () => { throw new Error('unexpected owner HTTP during draft generation'); } });
        return { repository, client };
      } });
    const pending = api.prepare({ enrollmentId: f.enrollment.id, stepId: f.version.steps[0]!.id, expectedVersion: 1 });
    const rejected = expect(pending).rejects.toThrow();
    await reachedHttp; expect(live).toBe(true); lifetime.abort();
    expect(httpSignal?.aborted).toBe(true); expect(ownerSignal?.aborted).toBe(true);
    release(Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ body: 'Late fictional response', evidenceIds: ['product:callie:description:v1'] }) }] }] }));
    await rejected; expect(live).toBe(false);
    expect(f.db.raw.prepare('SELECT count(*) AS n FROM manual_linkedin_drafts').get()).toEqual({ n: 0 });
  } finally { f.close(); }
});
