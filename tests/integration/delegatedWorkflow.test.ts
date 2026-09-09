import { countMilestones, readAcquisitionFacts } from '../../src/main/domain/campaign/acquisitionReport';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { ExecutionClient } from '../../src/main/delegation/executionClient';
import { ConditionalCommandHarness } from '../../cloud/lambdas/delegated-worker/test/sdkHarness';
import { WorkerAuth } from '../../cloud/lambdas/delegated-worker/src/workerAuth';
import { createWorkerHandler } from '../../cloud/lambdas/delegated-worker/src/handler';
import { DynamoExecutionRepository } from '../../cloud/lambdas/delegated-worker/src/executionRepository';
import type { DelegationCommand } from '../../src/shared/contracts/delegationContract';

async function fixture() {
  const local = await createPmFixture();
  const workspaceId = 'fictional-paired-workspace';
  const options = { dynamo: new ConditionalCommandHarness(), tableName: 'fictional-table', workspaceId, clock: { now: () => PM_NOW } };
  const auth = new WorkerAuth(options);
  const bootstrap = await auth.issuePairing({ scopes: ['commands:write', 'events:read'], expiresInSeconds: 300 });
  const pairing = await auth.redeemPairing(bootstrap.code, 'fictional-device');
  const handler = createWorkerHandler({ auth, host: 'worker.example.test' });
  const repository = new DelegationRepository({ database: local.db, workspaceId, clock: options.clock });
  const account = local.repo.create({ commandId: randomUUID(), name: 'Fictional PM', domain: null });
  repository.initializeLocalAuthority(account.id);
  await new DynamoExecutionRepository(options).seedLocalAuthority(account.id);
  let disconnected = false;
  const requests: string[] = [];
  const http: typeof fetch = async (input, init) => {
    if (disconnected) throw new Error('fictional offline');
    const url = new URL(String(input)); requests.push(url.pathname);
    const result = await handler({ version: '2.0', rawPath: url.pathname, rawQueryString: url.search.slice(1),
      headers: { host: url.host, 'x-forwarded-proto': 'https', authorization: new Headers(init?.headers).get('authorization') ?? '' },
      requestContext: { domainName: url.host, http: { method: init?.method ?? 'GET', sourceIp: 'fixture' } },
      ...(init?.body ? { body: String(init.body) } : {}) });
    return new Response(result.body, { status: result.statusCode, headers: result.headers });
  };
  const transport = new SqlDelegationTransport({ database: local.db, workspaceId, pairingId: pairing.pairingId, clock: options.clock });
  const client = new ExecutionClient({ repository, transport, pairing: { endpoint: 'https://worker.example.test', workspaceId, credential: pairing.credential }, fetch: http });
  const command: DelegationCommand = { commandId: randomUUID(), workspaceId, accountId: account.id, expectedAuthorityGeneration: 0,
    expectedVersion: 0, kind: 'delegate', payload: { delegationId: randomUUID(), approvedAt: PM_NOW } };
  return { ...local, repository, client, transport, command, auth, pairing, requests, disconnect: () => { disconnected = true; }, reconnect: () => { disconnected = false; } };
}

describe('C6 authenticated persistent local workflow', () => {
  it('keeps pending distinct from owner-applied state until authenticated event sync', async () => {
    const f = await fixture();
    try {
      expect(await f.client.submit(f.command)).toMatchObject({ status: 'pending' });
      expect(f.repository.authority(f.command.accountId)).toMatchObject({ owner: 'local', state: 'delegating' });
      expect(await f.client.sync(new AbortController().signal)).toMatchObject({ applied: 1, gaps: 0, ownerFresh: true });
      expect(f.transport.current()).toMatchObject({ state: 'complete', completedAt: PM_NOW });
      expect(f.repository.commandStatus(f.command.commandId)).toMatchObject({ status: 'applied' });
      expect(await f.client.submit(f.command)).toMatchObject({ status: 'applied' });
      expect(f.repository.authority(f.command.accountId)).toMatchObject({ owner: 'worker', state: 'active', generation: 1 });
      expect(await f.client.sync(new AbortController().signal)).toMatchObject({ applied: 0, gaps: 0 });
    } finally { f.close(); }
  });
  it('persists offline commands without claiming a remote pause and never retries through a local sender', async () => {
    const f = await fixture();
    try {
      await f.client.submit(f.command); await f.client.sync(new AbortController().signal);
      f.disconnect();
      const pause: DelegationCommand = { ...f.command, commandId: randomUUID(), kind: 'pause', expectedAuthorityGeneration: 1,
        expectedVersion: 1, payload: { reason: 'Owner requested pause while offline' } };
      expect(await f.client.submit(pause)).toMatchObject({ status: 'pending' });
      expect(f.repository.commandStatus(pause.commandId)).toMatchObject({ status: 'pending' });
      expect(f.repository.authority(pause.accountId)).toMatchObject({ state: 'active' });
      expect(await f.client.sync(new AbortController().signal)).toMatchObject({ ownerFresh: false });
      expect(f.transport.current()).toMatchObject({ state: 'failed', completedAt: null });
      f.reconnect();
      expect(await f.client.sync(new AbortController().signal)).toMatchObject({ gaps: 0, ownerFresh: true });
      expect(f.repository.commandStatus(pause.commandId)).toMatchObject({ status: 'applied' });
      expect(f.repository.authority(pause.accountId)).toMatchObject({ state: 'paused' });
    } finally { f.close(); }
  });
  it('refuses revoked credentials without accepting unauthenticated event freshness', async () => {
    const f = await fixture();
    try {
      await f.auth.revokePairing(f.pairing.pairingId);
      expect(await f.client.sync(new AbortController().signal)).toMatchObject({ applied: 0, ownerFresh: false });
      expect(f.repository.authority(f.command.accountId)).toMatchObject({ owner: 'local', state: 'local' });
    } finally { f.close(); }
  });
});

import { createExecutionRouter } from '../../src/main/delegation/executionRouter';
it('routes only explicit local/local authority and rejects every inactive or inconsistent pair', async () => {
  const f = await fixture();
  try {
    let sends = 0;
    const router = createExecutionRouter({ repository: f.repository,
      local: { send: async (_request, assertCurrent) => { assertCurrent(); sends++; return { status: 'local_dispatched' as const }; } },
      worker: { sendApproved: async () => { throw new Error('Unconfigured owner'); } } });
    const request = { accountId: f.command.accountId, commandId: randomUUID(), draftId: 'fictional-draft', expectedRevision: 1 };
    for (const [owner, state] of [['local', 'delegating'], ['local', 'active'], ['worker', 'paused'], ['worker', 'revoked']] as const) {
      f.db.raw.prepare('UPDATE delegated_authorities SET owner=?,state=? WHERE account_id=?').run(owner, state, request.accountId);
      expect(await router.routeSend(request)).toMatchObject({ status: 'held' });
    }
    expect(await router.routeSend({ ...request, accountId: 'missing' })).toMatchObject({ status: 'held' });
    expect(sends).toBe(0);
    expect(() => f.db.raw.prepare("UPDATE delegated_authorities SET owner='worker',state='local' WHERE account_id=?").run(request.accountId)).toThrow(/CHECK/);
    f.db.raw.prepare("UPDATE delegated_authorities SET owner='local',state='local' WHERE account_id=?").run(request.accountId);
    expect(await router.routeSend(request)).toMatchObject({ status: 'local_dispatched' });
    expect(sends).toBe(1);
  } finally { f.close(); }
});
it('holds worker-active when owner is unavailable with zero local fallback and rejects permission flags', async () => {
  const f = await fixture();
  try {
    f.db.raw.prepare("UPDATE delegated_authorities SET owner='worker',state='active',generation=1 WHERE account_id=?").run(f.command.accountId);
    let sends = 0;
    const router = createExecutionRouter({ repository: f.repository,
      local: { send: async () => { sends++; return { status: 'local_dispatched' as const }; } },
      worker: { sendApproved: async () => { throw new Error('Offline'); } } });
    const request = { accountId: f.command.accountId, commandId: randomUUID(), draftId: 'fictional-draft', expectedRevision: 1 };
    expect(await router.routeSend(request)).toMatchObject({ status: 'held' });
    await expect(router.routeSend({ ...request, senderAllowed: true } as typeof request)).rejects.toThrow();
    expect(sends).toBe(0);
  } finally { f.close(); }
});

import { createEmailService } from '../../src/main/outreach/emailService';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { createFounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { seedProspect, insertOpenCycleWithAction } from '../fixtures/domainRows';
it('blocks linked historical email when delegation begins during provider preparation', async () => {
  const f = await fixture(); let sent = 0;
  const clock = { now: () => PM_NOW }; const ids = { next: randomUUID };
  const services = createDomainServices({ database: f.db, clock, ids });
  services.unitOfWork.immediate(() => services.cadences.installBuiltins());
  const prospect = seedProspect(f.db.raw, 'delegated-email');
  insertOpenCycleWithAction({ database: f.db.raw, prefix: 'delegated-email', prospect });
  f.db.raw.prepare("INSERT INTO person_contact_methods(id,person_id,kind,normalized_value,validation_state,reachability,is_primary,created_at,updated_at) VALUES('delegated-address','delegated-email-person','email','recipient@example.test','valid','direct',1,?,?)").run(PM_NOW, PM_NOW);
  f.db.raw.prepare("INSERT INTO pm_account_links(id,account_id,kind,person_id,relationship,role,authority,valid_from,admitted_at) VALUES('delegated-link',?,'person_role','delegated-email-person','employee','manager','unconfirmed',?,?)").run(f.command.accountId, PM_NOW, PM_NOW);
  const domain = createFounderSalesDomain({ database: f.db, services, clock, ids });
  const status = { model: 'unconfigured' as const, modelName: '', gmail: 'ready' as const, accountEmail: 'sender@example.test', senderName: 'Fictional Sender', postalAddress: '1 Fictional Road' };
  const service = createEmailService({ databaseGate: { withDatabase: async run => run(f.db), withDomain: async run => run(domain) }, now: clock.now,
    providers: { status: async () => status, configure: async () => status, connectGmail: async () => status, disconnectGmail: async () => status, dispose: () => undefined,
      generate: async () => { throw new Error('Model forbidden'); }, prepare: async () => {
        f.repository.queueCommand(f.command);
        return { accountEmail: status.accountEmail, sendOnce: async () => { sent++; return { status: 'accepted', messageId: 'fictional-message', threadId: null }; } };
      } } });
  try {
    const draft = await service.openDraft({ personId: 'delegated-email-person', contactMethodId: 'delegated-address' });
    const saved = await service.saveDraft({ draftId: draft.id, expectedRevision: draft.revision, subject: 'Requested follow-up', body: 'Fictional reviewed content' });
    await expect(service.sendDraft({ draftId: saved.id, expectedRevision: saved.revision, commandId: randomUUID() })).rejects.toThrow(/authority/);
    expect(sent).toBe(0);
    expect(f.db.raw.prepare('SELECT * FROM email_send_intents').all()).toEqual([]);
  } finally { service.dispose(); f.close(); }
});

it('does not submit delegation while a linked historical send remains unknown', async () => {
  const f = await fixture();
  try {
    const raw = f.db.raw;
    raw.prepare("INSERT INTO pm_account_links(id,account_id,kind,person_id,relationship,role,authority,valid_from,admitted_at) VALUES('unknown-link',?,'person_role','historical-person','employee','manager','unconfirmed',?,?)").run(f.command.accountId, PM_NOW, PM_NOW);
    // Actual legacy schema stores immutable send uncertainty independently of the new account.
    const { EmailRepository } = await import('../../src/main/outreach/emailRepository');
    const prospect = seedProspect(raw, 'unknown-send'); insertOpenCycleWithAction({ database: raw, prefix: 'unknown-send', prospect });
    raw.prepare("INSERT INTO pm_account_links(id,account_id,kind,person_id,relationship,role,authority,valid_from,admitted_at) VALUES('unknown-sender-link',?,'person_role','unknown-send-person','employee','manager','unconfirmed',?,?)").run(f.command.accountId, PM_NOW, PM_NOW);
    raw.prepare("INSERT INTO person_contact_methods(id,person_id,kind,normalized_value,validation_state,reachability,is_primary,created_at,updated_at) VALUES('unknown-address','unknown-send-person','email','unknown@example.test','valid','direct',1,?,?)").run(PM_NOW, PM_NOW);
    const emails = new EmailRepository(f.db);
    const draft = emails.create({ id: 'unknown-draft', personId: 'unknown-send-person', salesCycleId: 'unknown-send-cycle', contactMethodId: 'unknown-address', recipient: 'unknown@example.test', contactSnapshot: 'a'.repeat(64), accountEmail: 'sender@example.test', footer: 'Fictional', updatedAt: PM_NOW });
    raw.transaction(() => emails.reserve({ email: { commandId: 'unknown-command', from: 'sender@example.test', to: draft.recipient, subject: 'Reviewed', body: 'Reviewed' },
      draftId: draft.id, draftRevision: draft.revision, personId: draft.personId, salesCycleId: draft.salesCycleId, prospectId: 'unknown-send-prospect', cycleVersion: 1, action: null, policyId: 'fictional-policy', createdAt: PM_NOW })).immediate();
    expect(await f.client.submit(f.command)).toMatchObject({ status: 'pending' });
    expect(f.repository.authority(f.command.accountId)).toMatchObject({ state: 'delegating' });
    expect(f.requests).not.toContain('/commands');
    expect(raw.prepare('SELECT * FROM email_send_results').all()).toEqual([]);
  } finally { f.close(); }
});

import { SqlDelegationTransport } from '../../src/main/delegation/delegationSync';
it('persists pending-before-HTTP transport attempts and rejects older completion after restart', async () => {
  const f = await fixture();
  try {
    const options = { database: f.db, workspaceId: f.command.workspaceId, pairingId: f.pairing.pairingId, clock: { now: () => PM_NOW } };
    const first = new SqlDelegationTransport(options); const attempt = first.begin();
    expect(first.current()).toMatchObject({ state: 'pending', completedAt: null });
    const restarted = new SqlDelegationTransport(options); const newer = restarted.begin();
    expect(() => first.finish(attempt, null, true)).toThrow();
    restarted.finish(newer, null, true);
    expect(restarted.current()).toMatchObject({ state: 'complete', completedAt: PM_NOW, revision: newer.revision });
    expect(new SqlDelegationTransport({ ...options, pairingId: 'other-pairing' }).current()).toBeNull();
  } finally { f.close(); }
});

it('holds new sends immediately when a durable stop is pending even if projected owner is active', async () => {
  const f = await fixture(); let attempts = 0;
  try {
    await f.client.submit(f.command); await f.client.sync(new AbortController().signal); f.disconnect();
    await f.client.submit({ ...f.command, commandId: randomUUID(), expectedAuthorityGeneration: 1, expectedVersion: 1, kind: 'pause', payload: { reason: 'Explicit stop' } });
    const router = createExecutionRouter({ repository: f.repository, local: { send: async () => { throw new Error('Forbidden fallback'); } },
      worker: { sendApproved: async () => { attempts++; return { status: 'worker_submitted', receipt: f.repository.commandStatus(f.command.commandId)! }; } } });
    expect(await router.routeSend({ accountId: f.command.accountId, commandId: randomUUID(), draftId: 'draft', expectedRevision: 1 })).toMatchObject({ status: 'held' });
    expect(attempts).toBe(0);
  } finally { f.close(); }
});

it('projects authenticated exact manual handoff and consumes once with caller mutation fence inside SQL', async () => {
  const f = await fixture();
  try {
    f.repo.admitEvidence({ commandId: randomUUID(), accountId: f.command.accountId, expectedVersion: 1, claims: [],
      sources: [{ id: 'manual-source', url: 'https://example.invalid/team', fetchedAt: PM_NOW, sha256: 'a'.repeat(64), excerpt: 'Fictional published phone', permitted: true }],
      routes: [{ id: 'manual-route', accountId: f.command.accountId, personId: 'historical-person', channel: 'phone', value: '+12025550123', purpose: 'business', evidenceIds: ['manual-source'], verification: 'published' }] });
    await f.client.submit(f.command); await f.client.sync(new AbortController().signal);
    const binding = { actionId: 'manual-action', channel: 'call' as const, routeId: 'manual-route', routeVersion: 1, targetHash: createHash('sha256').update('+12025550123').digest('hex'), contentHash: 'b'.repeat(64), contextRevision: 'context',
      campaign: { campaignId: 'campaign', campaignRevision: 1, enrollmentId: 'enrollment', enrollmentRevision: 1, stepId: 'call-step' } };
    const command = { ...f.command, commandId: randomUUID(), kind: 'prepare-manual' as const, expectedAuthorityGeneration: 1, expectedVersion: 1, payload: binding };
    f.repository.queueCommand(command);
    const payload = { ...binding, handoffId: 'handoff', expiresAt: '2026-09-08T12:01:00.000Z' };
    f.repository.applyWorkerEvent({ id: 'handoff-event', workspaceId: f.command.workspaceId, accountId: f.command.accountId, authorityGeneration: 1, aggregateVersion: 2,
      kind: 'manual.handoff', payload, receipt: { commandId: command.commandId, authorityGeneration: 1, aggregateVersion: 2, status: 'applied', reason: null } });
    expect(f.repository.commandStatus(command.commandId)?.status).toBe('applied');
    const input = { accountId: f.command.accountId, authorityGeneration: 1, ...payload };
    expect(() => f.repository.consumeManualHandoff(input, () => { expect(f.db.raw.inTransaction).toBe(true); throw new Error('Draft changed'); })).toThrow('Draft changed');
    expect(f.repository.getManualHandoff('handoff')?.consumedAt).toBeNull();
    expect(f.repository.consumeManualHandoff(input, () => { expect(f.db.raw.inTransaction).toBe(true); })).toMatchObject({ status: 'started' });
    expect(f.repository.consumeManualHandoff(input, () => undefined)).toMatchObject({ status: 'already_started' });
    expect(f.repository.getManualHandoff('handoff')?.consumedAt).toBe(PM_NOW);
  } finally { f.close(); }
});

it('captures an authenticated explicit pilot milestone through HTTP and immutable SQL replay once', async () => {
  const f = await fixture();
  try {
    await f.client.submit(f.command); await f.client.sync(new AbortController().signal);
    const command = { ...f.command, commandId: randomUUID(), expectedAuthorityGeneration: 1, expectedVersion: 1, kind: 'report-acquisition-milestone' as const,
      payload: { kind: 'pilot_started' as const, pilotId: 'fictional-pilot', occurredAt: PM_NOW, sourceRef: 'owner-note', ownerNote: 'Fictional owner-confirmed pilot started.' } };
    expect(await f.client.submit(command)).toMatchObject({ status: 'pending' });
    expect(await f.client.sync(new AbortController().signal)).toMatchObject({ ownerFresh: true, applied: 1 });
    expect(await f.client.submit(command)).toMatchObject({ status: 'applied' });
    expect(await f.client.sync(new AbortController().signal)).toMatchObject({ applied: 0 });
    expect(f.db.raw.prepare("SELECT COUNT(*) AS n FROM delegated_applied_events WHERE json_extract(event_json,'$.kind')='acquisition.milestone_reported'").get()).toEqual({ n: 1 });
    expect(countMilestones(readAcquisitionFacts(f.db), { start: '2026-09-08T00:00:00.000Z', end: '2026-09-09T00:00:00.000Z' })).toMatchObject({ pilotStarts: 1, meetingsHeld: 0 });
  } finally { f.close(); }
});

it('persists exact paired local configuration with CAS and an inactive default, without creating budget rights', async () => {
  const f = await fixture();
  try {
    const { SqlDelegationConfiguration } = await import('../../src/main/delegation/delegationSync');
    const store = new SqlDelegationConfiguration({ database: f.db, workspaceId: f.command.workspaceId, pairingId: f.pairing.pairingId, clock: { now: () => PM_NOW } });
    expect(store.read()).toBeNull();
    const configuration = { version: 1 as const, state: 'paused' as const, research: null as null };
    expect(store.configure({ expectedRevision: 0, configuration })).toMatchObject({ revision: 1, configuration });
    expect(() => store.configure({ expectedRevision: 0, configuration })).toThrow();
    expect(new SqlDelegationConfiguration({ database: f.db, workspaceId: f.command.workspaceId, pairingId: 'other-pairing', clock: { now: () => PM_NOW } }).read()).toBeNull();
    expect(f.db.raw.prepare('SELECT * FROM discovery_approved_budgets').all()).toEqual([]);
  } finally { f.close(); }
});
