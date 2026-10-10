import { composeCrmGmail, createServerCrmGmailAccessResolver } from '../../worker/src/bootstrap/crmGmail.ts';
import { localEnvelopeCipher } from '@fss/domain/mail/envelope.ts';
import { storeRefreshToken } from '@fss/domain/mail/tokens.ts';
import { repositoryContext } from '@fss/domain/db/workspaceScope.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createGmailHttpClient } from '@fss/domain/mail/gmailClientHttp.ts';
import { createGmailMailCaptureProvider } from '@fss/domain/mail/crmGmailProvider.ts';
import type { businessMailCaptureHandler } from '@fss/domain/mail/crmSources.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { registerHandlers } from '../../worker/src/bootstrap/main.ts';
function captureHandler(
  deps: Parameters<typeof businessMailCaptureHandler>[0],
) {
  const registry = registerHandlers(new HandlerRegistry(), {
    classifier: undefined,
    mail: undefined,
    send: undefined,
    research: undefined,
    crmMailCapture: deps,
  });
  const handler = registry.get('crm.mail_capture');
  if (!handler) throw new Error('CRM mail capture worker handler missing');
  return handler;
}

import { enqueueJob, claimJobs } from '@fss/domain/jobs/jobStore.ts';
import { businessAccountBinding } from '@fss/domain/business/acquisition.ts';
import { workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { createAuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { dispatch } from '../src/server.ts';

async function approveCaptureFixture(
  fixture: Awaited<ReturnType<typeof createAuthFixture>>,
  ownerUserId = fixture.alpha.admin.userId,
) {
  const workspaceId = fixture.alpha.workspaceId;
  const mailbox = (
    await fixture.db.query<{
      id: string;
      owner_user_id: string;
      email_address: string;
      provider_account_id: string;
      generation: number;
      status: string;
    }>(
      "INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'business@example.test','google-business','connected') RETURNING *",
      [workspaceId, ownerUserId],
    )
  ).rows[0]!;
  const binding = businessAccountBinding(workspaceId, mailbox)!;
  await fixture.db.query(
    "INSERT INTO crm_business_policies(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled) VALUES($1,$2,$3,'google-business',$4,1,1,false)",
    [workspaceId, mailbox.id, ownerUserId, binding],
  );
  const conversationId = (
    await fixture.db.query<{ id: string }>(
      "INSERT INTO crm_business_conversations(workspace_id,mailbox_id,owner_user_id,account_binding,provider_thread_id,subject,participants,latest_provider_at,category,reason,classifier_version,metadata_hash) VALUES($1,$2,$3,$4,'approved-thread','Business','[]',now(),'business','fixture','fixture',$5) RETURNING id",
      [workspaceId, mailbox.id, ownerUserId, binding, 'a'.repeat(64)],
    )
  ).rows[0]!.id;
  await fixture.db.query(
    "INSERT INTO crm_mail_capture_controls(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled,policy_revision,disclosure_version,disclosure_sha256,grant_receipt,provider_policy_receipt,evaluation_receipt,release_receipt) VALUES($1,$2,$3,'google-business',$4,1,1,true,1,'full-body-fixture',$5,'fixture-grant','fixture-provider','fixture-evaluation','fixture-release')",
    [workspaceId, mailbox.id, ownerUserId, binding, 'b'.repeat(64)],
  );
  await enqueueJob(fixture.db, {
    workspaceId,
    kind: 'crm.mail_capture',
    idempotencyKey: 'approved-fixture',
    payload: {
      mailboxId: mailbox.id,
      providerMessageId: 'approved-message',
      providerAccountId: 'google-business',
      generation: 1,
      conversationId,
      controlsRevision: 1,
      policyRevision: 1,
      decisionRevision: 0,
    },
  });
  const job = (
    await claimJobs(fixture.db, {
      owner: 'capture-fixture',
      kinds: ['crm.mail_capture'],
      limit: 1,
      leaseSeconds: 120,
    })
  )[0]!;
  return { workspaceId, ownerUserId, mailbox, binding, conversationId, job };
}

it('refuses body acquisition whose actual Gmail HTTP response omits its message identity', async () => {
  const fixture = await createAuthFixture();
  try {
    const approved = await approveCaptureFixture(fixture);
    let calls = 0;
    const gmail = createGmailHttpClient({ apiBaseUrl: 'https://gmail.example.test', fetch: async url => {
      calls++;
      const body = new URL(url).searchParams.get('format') === 'full';
      return { status: 200, headers: {}, body: JSON.stringify(body ? { payload: { mimeType: 'text/plain', body: { data: Buffer.from('Private business body').toString('base64url') } } } : { id: 'approved-message', threadId: 'approved-thread', internalDate: String(Date.now()), labelIds: ['INBOX'], payload: { headers: [{ name: 'From', value: 'person@example.test' }, { name: 'To', value: 'business@example.test' }, { name: 'Subject', value: 'Business' }] } }) };
    } });
    const handler = captureHandler({ proofVerifier: { verify: async () => true }, provider: createGmailMailCaptureProvider({ gmail, resolveAccess: async () => ({ mailboxId: approved.mailbox.id, providerAccountId: 'google-business', generation: 1, access: { accessToken: randomUUID(), expiresAtEpochSeconds: Date.now() / 1000 + 3600 } }) }) });
    await expect(handler.handle({ session: fixture.db, scope: workspaceScope(approved.workspaceId, { kind: 'system', component: 'worker' }), job: approved.job })).rejects.toMatchObject({ code: 'malformed_response' });
    expect(calls).toBe(2);
    const token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    const read = await dispatch({ method: 'POST', path: '/crm/business/mail/list', body: { mailboxId: approved.mailbox.id, limit: 20 }, query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` } }, { session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ sources: [] });
    expect(JSON.stringify(read.body)).not.toContain('Private business body');
  } finally { await fixture.stop(); }
});

it('reports verified body-free capture readiness while acquisition remains disabled', async () => {
  const fixture = await createAuthFixture();
  try {
    const approved = await approveCaptureFixture(fixture);
    await fixture.db.query("UPDATE crm_mail_capture_controls SET enabled=false WHERE workspace_id=$1 AND mailbox_id=$2", [approved.workspaceId, approved.mailbox.id]);
    await fixture.db.query("UPDATE crm_business_policies SET disclosure_version='metadata-fixture',disclosure_sha256=repeat('c',64) WHERE workspace_id=$1 AND mailbox_id=$2", [approved.workspaceId, approved.mailbox.id]);
    const token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    let proofs = 0;
    const read = await dispatch({ method: 'POST', path: '/crm/business/mail/controls/read', body: { mailboxId: approved.mailbox.id }, query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` } }, { session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false, crmMailCaptureReadiness: { adapterAvailable: () => true, proofVerifier: { async verify(proof) { proofs++; expect(proof.workspaceId).toBe(approved.workspaceId); expect(proof.accountBinding).toBe(approved.binding); expect(JSON.stringify(proof)).not.toContain('Private business body'); return true; } } } });
    expect(read.body).toMatchObject({ enabled: false, ready: true, reason: 'ready_disabled', revision: 1 });
    expect(proofs).toBe(1);
    const defaultRead = await dispatch({ method: 'POST', path: '/crm/business/mail/controls/read', body: { mailboxId: approved.mailbox.id }, query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` } }, { session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false });
    expect(defaultRead.body).toMatchObject({ enabled: false, ready: false, reason: 'acquisition_disabled', revision: 1 });
  } finally { await fixture.stop(); }
});

it('rechecks the exact control revision after provider verification and refuses drift', async () => {
  const fixture = await createAuthFixture();
  try {
    const approved = await approveCaptureFixture(fixture);
    await fixture.db.query("UPDATE crm_business_policies SET disclosure_version='metadata-fixture',disclosure_sha256=repeat('c',64) WHERE workspace_id=$1 AND mailbox_id=$2", [approved.workspaceId, approved.mailbox.id]);
    const token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    const other = await fixture.database.appRuntimeSession();
    {
      await other.query("SET statement_timeout='2s'");
      const read = await dispatch({ method: 'POST', path: '/crm/business/mail/controls/read', body: { mailboxId: approved.mailbox.id }, query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` } }, { session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false, crmMailCaptureReadiness: { adapterAvailable: () => true, proofVerifier: { async verify() { await other.query('UPDATE crm_mail_capture_controls SET revision=revision+1 WHERE workspace_id=$1 AND mailbox_id=$2', [approved.workspaceId, approved.mailbox.id]); return true; } } } });
      expect(read.body).toMatchObject({ ready: false, reason: 'binding_changed', revision: 2 });
    }
  } finally { await fixture.stop(); }
});

it.each(['captured', 'generation_changed'])('uses scoped server OAuth for the actual Gmail HTTP capture path (%s)', async scenario => {
  const fixture = await createAuthFixture();
  try {
    const approved = await approveCaptureFixture(fixture);
    const cipher = localEnvelopeCipher();
    await storeRefreshToken(repositoryContext(workspaceScope(approved.workspaceId, { kind: 'system', component: 'worker' }), fixture.db), { mailboxId: approved.mailbox.id, cipher, plaintext: randomBytes(32).toString('base64url') });
    const passage = 'Permitted native business conversation.';
    let tokenCalls = 0, bodyCalls = 0, sessionClosed = 0;
    const gmail = createGmailHttpClient({ apiBaseUrl: 'https://gmail.example.test', fetch: async url => {
      if (new URL(url).pathname === '/token') {
        tokenCalls++;
        if (scenario === 'generation_changed') await fixture.db.query('UPDATE mailboxes SET generation=2 WHERE workspace_id=$1 AND id=$2', [approved.workspaceId, approved.mailbox.id]);
        return { status: 200, headers: {}, body: JSON.stringify({ access_token: randomUUID(), expires_in: 3600, token_type: 'Bearer' }) };
      }
      const body = new URL(url).searchParams.get('format') === 'full';
      if (body) bodyCalls++;
      return { status: 200, headers: {}, body: JSON.stringify(body ? { id: 'approved-message', threadId: 'approved-thread', labelIds: ['INBOX'], payload: { mimeType: 'text/plain', body: { data: Buffer.from(passage).toString('base64url') } } } : { id: 'approved-message', threadId: 'approved-thread', internalDate: String(Date.now()), labelIds: ['INBOX'], payload: { headers: [{ name: 'From', value: 'person@example.test' }, { name: 'To', value: 'business@example.test' }, { name: 'Subject', value: 'Business' }] } }) };
    } });
    const resolveAccess = createServerCrmGmailAccessResolver({ gmail, cipher, oauth: { clientId: 'fixture', clientSecret: randomBytes(24).toString('base64url'), redirectUri: 'https://gmail.example.test/callback', authorizationEndpoint: 'https://gmail.example.test/authorize', tokenEndpoint: 'https://gmail.example.test/token', revocationEndpoint: 'https://gmail.example.test/revoke', apiBaseUrl: 'https://gmail.example.test' }, openSession: async () => ({ session: await fixture.database.appRuntimeSession(), close: async () => { sessionClosed++; } }) });
    const composition = composeCrmGmail({ gmail, resolveAccess, proofVerifier: { verify: async () => true }, allocationVerifier: { verify: async () => true }, observer: { observe: async () => {} } });
    const handler = registerHandlers(new HandlerRegistry(), { classifier: undefined, mail: undefined, send: undefined, research: undefined, ...composition }).get('crm.mail_capture')!;
    if (scenario === 'generation_changed') {
      await expect(handler.handle({ session: fixture.db, scope: workspaceScope(approved.workspaceId, { kind: 'system', component: 'worker' }), job: approved.job })).rejects.toThrow('CRM mail account proof unavailable');
      expect(bodyCalls).toBe(0);
      expect(sessionClosed).toBe(1);
    } else {
      const outcome = await handler.handle({ session: fixture.db, scope: workspaceScope(approved.workspaceId, { kind: 'system', component: 'worker' }), job: approved.job });
      expect(outcome).toMatchObject({ done: true, progress: { outcome: 'captured' } });
      expect(bodyCalls).toBe(1);
      expect(tokenCalls).toBe(2);
      expect(sessionClosed).toBe(2);
      const token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
      const read = await dispatch({ method: 'POST', path: '/crm/business/mail/read', body: { sourceId: outcome!.progress['sourceId'], sourceRevision: 1, contentHash: createHash('sha256').update(passage).digest('hex') }, query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` } }, { session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false });
      expect(read.body).toMatchObject({ state: 'available', source: { passage, mailboxId: approved.mailbox.id, acquiredGeneration: 1 } });
    }
  } finally { await fixture.stop(); }
});

it.each(['refused', 'exception'])('returns current controls rather than a stale pre-wait snapshot when readiness proof is %s', async outcome => {
  const fixture = await createAuthFixture();
  try {
    const approved = await approveCaptureFixture(fixture);
    await fixture.db.query("UPDATE crm_business_policies SET disclosure_version='metadata-fixture',disclosure_sha256=repeat('c',64) WHERE workspace_id=$1 AND mailbox_id=$2", [approved.workspaceId, approved.mailbox.id]);
    const token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    const read = await dispatch({ method: 'POST', path: '/crm/business/mail/controls/read', body: { mailboxId: approved.mailbox.id }, query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` } }, { session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false, crmMailCaptureReadiness: { adapterAvailable: () => true, proofVerifier: { async verify() { await fixture.db.query('UPDATE crm_mail_capture_controls SET enabled=false,revision=revision+1 WHERE workspace_id=$1 AND mailbox_id=$2', [approved.workspaceId, approved.mailbox.id]); if (outcome === 'exception') throw new Error('private proof failure'); return false; } } } });
    expect(read.body).toMatchObject({ enabled: false, ready: false, revision: 2 });
    expect(JSON.stringify(read.body)).not.toContain('private proof failure');
  } finally { await fixture.stop(); }
});

it.each(['received', 'sent'])('retains all inline MIME text and provider-observed %s origin without inventing authored ranges', async origin => {
  const fixture = await createAuthFixture();
  try {
    const approved = await approveCaptureFixture(fixture);
    const labels = origin === 'sent' ? ['SENT'] : ['INBOX'];
    const text = 'Please review the repairs.\nOn Tuesday the owner wrote: please stop.';
    const gmail = createGmailHttpClient({ apiBaseUrl: 'https://gmail.example.test', fetch: async url => ({ status: 200, headers: {}, body: JSON.stringify(new URL(url).searchParams.get('format') === 'full' ? { id: 'approved-message', threadId: 'approved-thread', labelIds: labels, payload: { mimeType: 'multipart/mixed', parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Please review the repairs.').toString('base64url') } }, { mimeType: 'text/plain', body: { data: Buffer.from('On Tuesday the owner wrote: please stop.').toString('base64url') } }] } } : { id: 'approved-message', threadId: 'approved-thread', internalDate: String(Date.now()), labelIds: labels, payload: { headers: [{ name: 'From', value: origin === 'sent' ? 'business@example.test' : 'person@example.test' }, { name: 'To', value: origin === 'sent' ? 'person@example.test' : 'business@example.test' }, { name: 'Subject', value: 'Business' }] } }) }) });
    const handler = captureHandler({ proofVerifier: { verify: async () => true }, provider: createGmailMailCaptureProvider({ gmail, resolveAccess: async () => ({ mailboxId: approved.mailbox.id, providerAccountId: 'google-business', generation: 1, access: { accessToken: randomUUID(), expiresAtEpochSeconds: Date.now() / 1000 + 3600 } }) }) });
    const outcome = await handler.handle({ session: fixture.db, scope: workspaceScope(approved.workspaceId, { kind: 'system', component: 'worker' }), job: approved.job });
    expect(outcome).toMatchObject({ progress: { outcome: 'captured' } });
    const token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    const read = await dispatch({ method: 'POST', path: '/crm/business/mail/read/v2', body: { sourceId: outcome!.progress['sourceId'], sourceRevision: 1, contentHash: createHash('sha256').update(text).digest('hex') }, query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` } }, { session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false });
    expect(read.body).toMatchObject({ state: 'available', source: { passage: text, direction: origin === 'sent' ? 'outgoing' : 'incoming', completeness: 'complete', sentProof: false } });
    expect(JSON.stringify(read.body)).not.toContain('"kind":"authored"');
  } finally { await fixture.stop(); }
});


it.each(['attachment', 'html', 'truncated', 'draft', 'changed_labels', 'changed_thread'])('preserves conservative public capture evidence for %s', async scenario => {
  const fixture = await createAuthFixture();
  try {
    const approved = await approveCaptureFixture(fixture);
    const text = scenario === 'truncated' ? 'Permitted b' : 'Permitted body';
    const labels = scenario === 'draft' ? ['SENT', 'DRAFT'] : ['INBOX'];
    const payload = scenario === 'attachment' ? { mimeType: 'multipart/mixed', parts: [{ mimeType: 'text/plain', body: { data: Buffer.from(text).toString('base64url') } }, { mimeType: 'text/plain', filename: 'private.txt', body: { attachmentId: 'do-not-fetch', data: Buffer.from('ATTACHMENT PRIVATE').toString('base64url') } }] } : { mimeType: scenario === 'html' ? 'text/html' : 'text/plain', body: { data: Buffer.from(scenario === 'html' ? '<p>Permitted body</p>' : 'Permitted body').toString('base64url') } };
    let reads = 0;
    const gmail = createGmailHttpClient({ apiBaseUrl: 'https://gmail.example.test', ...(scenario === 'truncated' ? { maxBodyCharacters: 11 } : {}), fetch: async url => {
      reads++;
      const full = new URL(url).searchParams.get('format') === 'full';
      return { status: 200, headers: {}, body: JSON.stringify(full ? { id: 'approved-message', threadId: scenario === 'changed_thread' ? 'other-thread' : 'approved-thread', labelIds: scenario === 'changed_labels' ? ['SENT'] : labels, payload } : { id: 'approved-message', threadId: 'approved-thread', internalDate: String(Date.now()), labelIds: labels, payload: { headers: [{ name: 'From', value: 'person@example.test' }, { name: 'To', value: 'business@example.test' }, { name: 'Subject', value: 'Business' }] } }) };
    } });
    const handler = captureHandler({ proofVerifier: { verify: async () => true }, provider: createGmailMailCaptureProvider({ gmail, resolveAccess: async () => ({ mailboxId: approved.mailbox.id, providerAccountId: 'google-business', generation: 1, access: { accessToken: randomUUID(), expiresAtEpochSeconds: Date.now() / 1000 + 3600 } }) }) });
    const result = handler.handle({ session: fixture.db, scope: workspaceScope(approved.workspaceId, { kind: 'system', component: 'worker' }), job: approved.job });
    if (scenario.startsWith('changed_')) {
      await expect(result).rejects.toThrow('CRM mail body');
    } else {
      const outcome = await result;
      expect(outcome).toMatchObject({ progress: { outcome: 'captured' } });
      const token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
      const read = await dispatch({ method: 'POST', path: '/crm/business/mail/read/v2', body: { sourceId: outcome!.progress['sourceId'], sourceRevision: 1, contentHash: createHash('sha256').update(text).digest('hex') }, query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` } }, { session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false });
      expect(read.body).toMatchObject({ state: 'available', source: { passage: text, completeness: scenario === 'draft' ? 'complete' : 'partial', sentProof: false } });
      expect(JSON.stringify(read.body)).not.toContain('ATTACHMENT PRIVATE');
      expect(JSON.stringify(read.body)).not.toContain('"kind":"authored"');
    }
    expect(reads).toBe(2);
  } finally { await fixture.stop(); }
});
