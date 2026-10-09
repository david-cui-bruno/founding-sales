import { setTimeout as delay } from 'node:timers/promises';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { observeBusinessMetadata, redactBusinessMetadata } from '@fss/domain/business/acquisition.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
describe('disabled business acquisition policy and metadata review', () => {
  let fixture: AuthFixture;
  let token: string;
  let mailboxId: string;
  const post = (path: string, body: unknown, bearer = token) => dispatch({ method: 'POST', path, query: new URLSearchParams(), headers: { authorization: `Bearer ${bearer}` }, body }, { session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false });
  const command = (payload: Record<string, unknown>) => ({ commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, ...payload });
  beforeAll(async () => {
    fixture = await createAuthFixture();
    token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    const row = (await fixture.db.query<{
      id: string;
    }>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'business@example.test','google-business','connected') RETURNING id", [fixture.alpha.workspaceId, fixture.alpha.admin.userId])).rows[0];
    if (row === undefined)
      throw new Error('Mailbox fixture unavailable');
    mailboxId = row.id;
  });
  afterAll(async () => { await fixture.stop(); });
  it('saves and reads a disabled mailbox-bound policy without changing sender controls', async () => {
    const sendingBefore = await post('/outreach/control/v2', {});
    const initial = await post('/crm/business/policy/read', { mailboxId });
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ mailboxId, revision: 0, enabled: false, ready: false, scopeDays: 90, classificationMode: 'metadata_only', disclosure: null });
    const { generation, accountBinding } = initial.body as {
      generation: number;
      accountBinding: string;
    };
    const save = command({ mailboxId, expectedRevision: 0, expectedGeneration: generation, expectedAccountBinding: accountBinding, enabled: false, disclosure: null });
    expect((await post('/crm/business/policy/save', save)).body).toMatchObject({ status: 'accepted', result: { revision: 1 } });
    expect((await post('/crm/business/policy/save', save)).body).toMatchObject({ replayed: true, result: { revision: 1 } });
    expect((await post('/crm/business/policy/read', {})).body).toMatchObject({ mailboxId, revision: 1, enabled: false, ready: false, reasons: expect.arrayContaining(['disclosure_required', 'activation_not_available']) });
    expect((await post('/crm/business/policy/save', { ...save, commandId: randomUUID(), expectedRevision: 1, enabled: true })).body).toMatchObject({ status: 'refused', reason: 'activation_not_available' });
    expect((await post('/outreach/control/v2', {})).body).toEqual(sendingBefore.body);
  });
  it('stages proven metadata only after disclosure and exposes review without capture authority', async () => {
    const worker = repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'system', component: 'worker' }), fixture.db);
    const observation = { mailboxId, providerAccountId: 'google-business', generation: 1, expectedPolicyRevision: 1, providerThreadId: 'thread-1', providerMessageId: 'message-1', subject: 'Business inquiry', participants: ['contact@example.test'], latestProviderAt: '2026-10-09T12:00:00.000Z', category: 'uncertain' as const, reason: 'unclassified_metadata', classifierVersion: 'metadata-v1' };
    expect(await withTransaction(fixture.db, () => observeBusinessMetadata(worker, observation))).toMatchObject({ ok: false, reason: 'metadata_review_unavailable' });
    const policy = (await post('/crm/business/policy/read', { mailboxId })).body as {
      generation: number;
      accountBinding: string;
      revision: number;
      metadataReviewDisclosure: {
        version: string;
        sha256: string;
      };
    };
    expect((await post('/crm/business/policy/save', command({ mailboxId, expectedGeneration: policy.generation, expectedAccountBinding: policy.accountBinding, expectedRevision: policy.revision, enabled: false, disclosure: policy.metadataReviewDisclosure }))).body).toMatchObject({ status: 'accepted' });
    expect(await withTransaction(fixture.db, () => observeBusinessMetadata(worker, { ...observation, expectedPolicyRevision: 2 }))).toMatchObject({ ok: true });
    const read = await post('/crm/business/review/read', { mailboxId });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ available: true, captureAllowed: false, policyRevision: 2, conversations: [{ subject: 'Business inquiry', category: 'uncertain', effectiveDecision: 'needs_review', metadataRevision: 1, decisionRevision: 0, captureAllowed: false }] });
    expect(JSON.stringify(read.body)).not.toMatch(/snippet|body|fullText/);
  });
  it('preserves explicit exclusions through reclassification and same-account reconnect but not account changes', async () => {
    const worker = repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'system', component: 'worker' }), fixture.db);
    const page = (await post('/crm/business/review/read', { mailboxId })).body as {
      accountBinding: string;
      generation: number;
      policyRevision: number;
      conversations: {
        conversationId: string;
        metadataRevision: number;
        decisionRevision: number;
      }[];
    };
    const row = page.conversations[0];
    if (row === undefined)
      throw new Error('Review fixture unavailable');
    const decide = command({ mailboxId, conversationId: row.conversationId, expectedAccountBinding: page.accountBinding, expectedGeneration: page.generation, expectedPolicyRevision: page.policyRevision, expectedMetadataRevision: row.metadataRevision, expectedDecisionRevision: row.decisionRevision, decision: 'exclude' });
    expect((await post('/crm/business/review/decide', decide)).body).toMatchObject({ status: 'accepted', result: { decisionRevision: 1, captureAllowed: false } });
    expect((await post('/crm/business/review/decide', decide)).body).toMatchObject({ replayed: true, result: { decisionRevision: 1 } });
    await withTransaction(fixture.db, () => observeBusinessMetadata(worker, { mailboxId, providerAccountId: 'google-business', generation: 1, expectedPolicyRevision: 2, providerThreadId: 'thread-1', providerMessageId: 'message-2', subject: 'Business inquiry', participants: ['contact@example.test'], latestProviderAt: '2026-10-09T12:00:00.000Z', category: 'business', reason: 'business_metadata', classifierVersion: 'metadata-v2' }));
    expect((await post('/crm/business/review/read', { mailboxId })).body).toMatchObject({ conversations: [{ humanDecision: 'exclude', effectiveDecision: 'excluded', metadataRevision: 2, decisionRevision: 1, captureAllowed: false }] });
    expect((await post('/crm/business/review/decide', { ...decide, commandId: randomUUID(), decision: 'include', expectedDecisionRevision: 1 })).body).toMatchObject({ status: 'refused', reason: 'stale_metadata' });
    await fixture.db.query("UPDATE mailboxes SET generation=generation+1,email_address='business-reconnected@example.test' WHERE workspace_id=$1 AND id=$2", [fixture.alpha.workspaceId, mailboxId]);
    expect((await post('/crm/business/review/read', { mailboxId })).body).toMatchObject({ available: false, reasons: expect.arrayContaining(['mailbox_binding_changed']), conversations: [] });
    const reconnected = (await post('/crm/business/policy/read', { mailboxId })).body as {
      accountBinding: string;
      generation: number;
      revision: number;
      metadataReviewDisclosure: {
        version: string;
        sha256: string;
      };
    };
    expect(reconnected.accountBinding).toBe(page.accountBinding);
    await post('/crm/business/policy/save', command({ mailboxId, expectedAccountBinding: reconnected.accountBinding, expectedGeneration: reconnected.generation, expectedRevision: reconnected.revision, enabled: false, disclosure: reconnected.metadataReviewDisclosure }));
    expect((await post('/crm/business/review/read', { mailboxId })).body).toMatchObject({ conversations: [{ humanDecision: 'exclude', decisionRevision: 1 }] });
    await fixture.db.query("UPDATE mailboxes SET generation=generation+1,provider_account_id='different-google-account' WHERE workspace_id=$1 AND id=$2", [fixture.alpha.workspaceId, mailboxId]);
    const changed = (await post('/crm/business/policy/read', { mailboxId })).body as typeof reconnected;
    expect(changed.accountBinding).not.toBe(page.accountBinding);
    await post('/crm/business/policy/save', command({ mailboxId, expectedAccountBinding: changed.accountBinding, expectedGeneration: changed.generation, expectedRevision: changed.revision, enabled: false, disclosure: changed.metadataReviewDisclosure }));
    expect((await post('/crm/business/review/read', { mailboxId })).body).toMatchObject({ available: true, conversations: [] });
    expect((await post('/crm/business/review/decide', { ...decide, commandId: randomUUID(), expectedGeneration: changed.generation, expectedAccountBinding: changed.accountBinding, expectedPolicyRevision: 4 })).body).toMatchObject({ status: 'refused', reason: 'conversation_unavailable' });
  });
  it('returns stable duplicate observer receipts and retains content-free no-resurrection identity after whole metadata deletion', async () => {
    const worker = repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'system', component: 'worker' }), fixture.db);
    const policy = (await post('/crm/business/policy/read', { mailboxId })).body as {
      generation: number;
      revision: number;
      accountBinding: string;
    };
    const observation = { mailboxId, providerAccountId: 'different-google-account', generation: policy.generation, expectedPolicyRevision: policy.revision, providerThreadId: 'private-thread', providerMessageId: 'private-message', subject: 'Selected business conversation', participants: ['Alex@EXAMPLE.test', 'office@example.test'], latestProviderAt: new Date().toISOString(), category: 'business' as const, reason: 'business_metadata', classifierVersion: 'metadata-v1' };
    const first = await withTransaction(fixture.db, () => observeBusinessMetadata(worker, observation));
    expect(first).toMatchObject({ ok: true, value: { metadataRevision: 1 } });
    expect(await withTransaction(fixture.db, () => observeBusinessMetadata(worker, observation))).toEqual(first);
    const page = (await post('/crm/business/review/read', { mailboxId })).body as {
      conversations: {
        conversationId: string;
      }[];
    };
    const row = page.conversations[0];
    if (row === undefined)
      throw new Error('No staged conversation');
    const decide = command({ mailboxId, conversationId: row.conversationId, expectedAccountBinding: policy.accountBinding, expectedGeneration: policy.generation, expectedPolicyRevision: policy.revision, expectedMetadataRevision: 1, expectedDecisionRevision: 0, decision: 'include' });
    expect((await post('/crm/business/review/decide', decide)).body).toMatchObject({ status: 'accepted', result: { captureAllowed: false } });
    expect(await withTransaction(fixture.db, () => redactBusinessMetadata(worker, { targetAddresses: ['Alex@example.test'] }))).toMatchObject({ ok: true, value: { redacted: 1 } });
    expect((await post('/crm/business/review/read', { mailboxId })).body).toMatchObject({ conversations: [] });
    expect((await post('/crm/business/review/decide', { ...decide, commandId: randomUUID(), expectedDecisionRevision: 1 })).body).toMatchObject({ status: 'refused', reason: 'conversation_unavailable' });
    expect(await withTransaction(fixture.db, () => observeBusinessMetadata(worker, observation))).toMatchObject({ ok: false, reason: 'metadata_deleted' });
  });
  it('refuses body-bearing or unproven observations and keeps excluded categories owner-private', async () => {
    const worker = repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'system', component: 'worker' }), fixture.db);
    const policy = (await post('/crm/business/policy/read', { mailboxId })).body as {
      generation: number;
      revision: number;
    };
    const observation = { mailboxId, providerAccountId: 'different-google-account', generation: policy.generation, expectedPolicyRevision: policy.revision, providerThreadId: 'receipt-thread', providerMessageId: 'receipt-message', subject: 'Receipt', participants: ['billing@example.test'], latestProviderAt: new Date().toISOString(), category: 'receipt' as const, reason: 'receipt_headers', classifierVersion: 'metadata-v1' };
    expect(await withTransaction(fixture.db, () => observeBusinessMetadata(worker, { ...observation, body: 'Must never be retained' }))).toMatchObject({ ok: false, reason: 'invalid_metadata' });
    expect(await withTransaction(fixture.db, () => observeBusinessMetadata(worker, { ...observation, providerAccountId: 'unproven-old-account' }))).toMatchObject({ ok: false, reason: 'mailbox_binding_changed' });
    expect(await withTransaction(fixture.db, () => observeBusinessMetadata(worker, observation))).toMatchObject({ ok: true });
    for (const category of ['personal', 'newsletter', 'routine_support'] as const)
      await withTransaction(fixture.db, () => observeBusinessMetadata(worker, { ...observation, category, providerThreadId: category + '-thread', providerMessageId: category + '-message', reason: category === 'personal' ? 'personal_metadata' : category === 'newsletter' ? 'newsletter_headers' : 'routine_support_headers' }));
    const page = (await post('/crm/business/review/read', { mailboxId })).body as {
      conversations: {
        category: string;
        effectiveDecision: string;
        captureAllowed: boolean;
      }[];
    };
    expect(page.conversations).toHaveLength(4);
    expect(page.conversations.every(row => row.effectiveDecision === 'excluded' && row.captureAllowed === false)).toBe(true);
    const first = (await post('/crm/business/review/read', { mailboxId, limit: 1 })).body as {
      conversations: unknown[];
      nextAfter: string;
    };
    expect(first.conversations).toHaveLength(1);
    expect(first.nextAfter).toBeTypeOf('string');
    expect((await post('/crm/business/review/read', { mailboxId, limit: 100, after: first.nextAfter })).body).toMatchObject({ conversations: expect.arrayContaining([]), nextAfter: null });
    const salesperson = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    const otherWorkspace = (await issueSessionFor(fixture, fixture.beta, fixture.beta.admin)).accessToken;
    expect((await post('/crm/business/review/read', { mailboxId }, salesperson)).status).toBe(404);
    expect((await post('/crm/business/review/read', { mailboxId }, otherWorkspace)).status).toBe(404);
    expect((await post('/crm/business/policy/read', {}, salesperson)).body).toMatchObject({ mailboxId: null, ownerUserId: null, revision: 0 });
  });

  it('removes a deleted whole copy before a waiting review page can publish metadata',async()=>{
   const holder=await fixture.database.appRuntimeSession();const observer=await fixture.database.appRuntimeSession();
   const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
   await holder.query('BEGIN');
   await redactBusinessMetadata(repositoryContext(workspaceScope(fixture.alpha.workspaceId,{kind:'system',component:'worker'}),holder),{targetAddresses:['billing@example.test']});
   const pending=post('/crm/business/review/read',{mailboxId});
   try{await waitForBlock(observer,pid);}finally{await holder.query('COMMIT');}
   const page=(await pending).body as {conversations:{category:string;participants:string[]}[]};
   expect(page.conversations).toEqual([]);
  });
  it('vetoes metadata publication after account change while a read waits on the mailbox lock', async () => {
    const holder = await fixture.database.appRuntimeSession();
    const observer = await fixture.database.appRuntimeSession();
    const pid = (await holder.query<{
      pid: number;
    }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    await holder.query('BEGIN');
    await holder.query("UPDATE mailboxes SET generation=generation+1,provider_account_id='replaced-account' WHERE workspace_id=$1 AND id=$2", [fixture.alpha.workspaceId, mailboxId]);
    const pending = post('/crm/business/review/read', { mailboxId });
    try {
      await waitForBlock(observer, pid);
    }
    finally {
      await holder.query('COMMIT');
    }
    expect((await pending).body).toMatchObject({ available: false, conversations: [], reasons: expect.arrayContaining(['mailbox_binding_changed']) });
  });
  it('vetoes owner publication after membership departure while waiting on a mailbox lock', async () => {
    await fixture.db.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')", [fixture.alpha.workspaceId, fixture.beta.admin.userId]);
    const holder = await fixture.database.appRuntimeSession();
    const observer = await fixture.database.appRuntimeSession();
    const pid = (await holder.query<{
      pid: number;
    }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM mailboxes WHERE workspace_id=$1 AND id=$2 FOR NO KEY UPDATE', [fixture.alpha.workspaceId, mailboxId]);
    const pending = post('/crm/business/policy/read', { mailboxId });
    try {
      await waitForBlock(observer, pid);
      await holder.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2", [fixture.alpha.workspaceId, fixture.alpha.admin.userId]);
    }
    finally {
      await holder.query('COMMIT');
    }
    expect((await pending).status).toBe(404);
  });
});
async function waitForBlock(observer: SessionQueryable, pid: number | undefined) { for (let attempt = 0; attempt < 200; attempt++) {
  const rows = (await observer.query<{
    blocked: boolean;
  }>('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [pid])).rows;
  if (rows[0]?.blocked)
    return;
  await delay(5);
} throw new Error('Public operation did not reach the mailbox barrier'); }
