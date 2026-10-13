import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { enqueueJob, claimJobs } from '@fss/domain/jobs/jobStore.ts';
import { businessAccountBinding } from '@fss/domain/business/acquisition.ts';
import { workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { registerHandlers } from '../../worker/src/bootstrap/main.ts';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

let fixture: AuthFixture;
let token: string;
const command = (body: object) => ({ commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, ...body });
const post = (path: string, body: unknown) => dispatch({ method: 'POST', path, body,
  query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` } },
{ session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false });

/** Controlled canonical capture proves source provenance, not actual Gmail or booking consent. */
async function admittedMessage(text: string) {
  const workspaceId = fixture.alpha.workspaceId, ownerUserId = fixture.alpha.admin.userId;
  const key = randomUUID();
  const mailbox = (await fixture.db.query<{ id: string; owner_user_id: string; email_address: string; provider_account_id: string; generation: number; status: string }>(
    "INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,$3,$4,'connected') RETURNING *",
    [workspaceId, ownerUserId, `${key}@example.test`, key])).rows[0]!;
  const binding = businessAccountBinding(workspaceId, mailbox)!;
  await fixture.db.query("INSERT INTO crm_business_policies(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled) VALUES($1,$2,$3,$4,$5,1,1,false)", [workspaceId, mailbox.id, ownerUserId, key, binding]);
  const conversationId = (await fixture.db.query<{ id: string }>(
    "INSERT INTO crm_business_conversations(workspace_id,mailbox_id,owner_user_id,account_binding,provider_thread_id,subject,participants,latest_provider_at,category,reason,classifier_version,metadata_hash) VALUES($1,$2,$3,$4,$5,'Business','[]',now(),'business','fixture','fixture',$6) RETURNING id",
    [workspaceId, mailbox.id, ownerUserId, binding, key, 'a'.repeat(64)])).rows[0]!.id;
  await fixture.db.query("INSERT INTO crm_mail_capture_controls(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled,policy_revision,disclosure_version,disclosure_sha256,grant_receipt,provider_policy_receipt,evaluation_receipt,release_receipt) VALUES($1,$2,$3,$4,$5,1,1,true,1,'controlled-capture',$6,'fixture-grant','fixture-provider','fixture-evaluation','fixture-release')", [workspaceId, mailbox.id, ownerUserId, key, binding, 'b'.repeat(64)]);
  await enqueueJob(fixture.db, { workspaceId, kind: 'crm.mail_capture', idempotencyKey: key,
    payload: { mailboxId: mailbox.id, providerMessageId: key, providerAccountId: key, generation: 1, conversationId, controlsRevision: 1, policyRevision: 1, decisionRevision: 0 } });
  const job = (await claimJobs(fixture.db, { owner: 'booking-capture-fixture', kinds: ['crm.mail_capture'], limit: 1, leaseSeconds: 120 }))[0]!;
  const registry = registerHandlers(new HandlerRegistry(), { classifier: undefined, mail: undefined, send: undefined, research: undefined,
    crmMailCapture: { proofVerifier: { verify: async proof => proof.accountBinding === binding && proof.grantReceipt === 'fixture-grant' },
      provider: { read: async () => ({ providerAccountId: key, messageId: key, threadId: key, labels: ['INBOX'], providerAt: '2026-10-13T14:00:00.000Z', rawSenderDate: 'Tue, 13 Oct 2026 10:00:00 -0400', from: 'casey@example.test', to: [mailbox.email_address], cc: [], subject: 'Call', body: text, parserVersion: 'controlled-v1', representation: 'plain_text', completeness: 'complete', ranges: [{ start: 0, end: text.length, kind: 'authored' }] }) } } });
  const handler = registry.get('crm.mail_capture');
  if (!handler) throw new Error('registered capture missing');
  const result = await handler.handle({ session: fixture.db, scope: workspaceScope(workspaceId, { kind: 'system', component: 'worker' }), job });
  const sourceId = result?.progress['sourceId'];
  if (typeof sourceId !== 'string') throw new Error('canonical admission failed');
  return { sourceId, sourceRevision: 1, contentHash: createHash('sha256').update(text).digest('hex') };
}

beforeAll(async () => { fixture = await createAuthFixture(); token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken; });
afterAll(async () => { await fixture.stop(); });

it('shows booking interpretation unavailable without booking authority rather than borrowing capture or extraction grants', async () => {
  const source = await admittedMessage('Yes, let us arrange a call.');
  const original = await post('/crm/business/mail/read', source);
  expect(original.status).toBe(200);
  const requested = await post('/crm/booking/interpretation/request', command({ source, priorSources: [] }));
  expect(requested.status).toBe(200);
  expect(requested.body).toMatchObject({ result: { state: 'unavailable', reason: 'booking_authority_unavailable', outcome: null } });
  const requestId = (requested.body as { result: { requestId: string } }).result.requestId;
  const read = await post('/crm/booking/interpretation/read', { requestId });
  expect(read.body).toMatchObject({ state: 'unavailable', reason: 'booking_authority_unavailable', outcome: null,
    provenance: { source, occurredAt: '2026-10-13T14:00:00.000Z', rawSenderDate: 'Tue, 13 Oct 2026 10:00:00 -0400', participant: 'casey@example.test' },
    limitations: expect.arrayContaining(['no_sending_or_booking', 'linkedin_intake_unavailable']) });
  expect(JSON.stringify(read.body)).not.toContain('Yes, let us arrange a call.');
});
