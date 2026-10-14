import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { bookingInterpretationViewSchema, wireDrift, type BookingPolicyBindings } from '@fss/contracts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { enqueueJob, claimJobs } from '@fss/domain/jobs/jobStore.ts';
import { businessAccountBinding } from '@fss/domain/business/acquisition.ts';
import { workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { createBookingInterpretationAuthority } from '@fss/domain/crm/bookingInterpretationAuthority.ts';
import type { BookingInterpretationAuthorityPort } from '@fss/domain/crm/bookingInterpretationAuthority.ts';
import type { BookingPolicyRuntime } from '@fss/domain/meetings/bookingPolicyTypes.ts';
import { registerHandlers } from '../../worker/src/bootstrap/main.ts';
import { runOnce } from '../../worker/src/runner/jobRunner.ts';
import { createBookingInterpretationModel } from '../../worker/src/providers/bookingInterpretationModel.ts';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

let fixture: AuthFixture;
let token: string;
let authority: BookingInterpretationAuthorityPort | undefined;
const command = (body: object) => ({ commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, ...body });
const post = async (path: string, body: unknown) => {
  const response = await dispatch({ method: 'POST', path, body, query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` } },
    { session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false, ...(authority ? { bookingInterpretationAuthority: authority } : {}) });
  if (response.status === 200 && path.startsWith('/crm/booking/interpretation/')) {
    const envelope = response.body as { result?: unknown };
    expect(wireDrift(bookingInterpretationViewSchema, envelope.result ?? response.body)).toEqual([]);
  }
  return response;
};
beforeEach(async () => {
  authority = undefined;
  fixture = await createAuthFixture();
  token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
});
afterEach(async () => { await fixture.stop(); });

/** Minimum local copy of the existing canonical capture/configuredRequest seam. Controlled evidence is not live provider acceptance. */
async function admittedMessage(text: string, outgoing = false, authoredLength = text.length) {
  const workspaceId = fixture.alpha.workspaceId, ownerUserId = fixture.alpha.admin.userId, key = randomUUID();
  let mailbox = (await fixture.db.query<{ id: string; owner_user_id: string; email_address: string; provider_account_id: string; generation: number; status: string }>('SELECT * FROM mailboxes WHERE workspace_id=$1 AND owner_user_id=$2', [workspaceId, ownerUserId])).rows[0];
  const fresh = mailbox === undefined;
  mailbox ??= (await fixture.db.query<{ id: string; owner_user_id: string; email_address: string; provider_account_id: string; generation: number; status: string }>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,$3,$4,'connected') RETURNING *", [workspaceId, ownerUserId, `${key}@example.test`, key])).rows[0]!;
  const binding = businessAccountBinding(workspaceId, mailbox)!;
  if (fresh) {
    await fixture.db.query("INSERT INTO crm_business_policies(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled) VALUES($1,$2,$3,$4,$5,1,1,false)", [workspaceId, mailbox.id, ownerUserId, key, binding]);
    await fixture.db.query("INSERT INTO crm_business_conversations(workspace_id,mailbox_id,owner_user_id,account_binding,provider_thread_id,subject,participants,latest_provider_at,category,reason,classifier_version,metadata_hash) VALUES($1,$2,$3,$4,$5,'Business','[]',now(),'business','fixture','fixture',$6)", [workspaceId, mailbox.id, ownerUserId, binding, key, 'a'.repeat(64)]);
    await fixture.db.query("INSERT INTO crm_mail_capture_controls(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled,policy_revision,disclosure_version,disclosure_sha256,grant_receipt,provider_policy_receipt,evaluation_receipt,release_receipt) VALUES($1,$2,$3,$4,$5,1,1,true,1,'controlled-capture',$6,'fixture-grant','fixture-provider','fixture-evaluation','fixture-release')", [workspaceId, mailbox.id, ownerUserId, key, binding, 'b'.repeat(64)]);
  }
  const conversation = (await fixture.db.query<{ id: string; provider_thread_id: string }>('SELECT id,provider_thread_id FROM crm_business_conversations WHERE workspace_id=$1 AND mailbox_id=$2', [workspaceId, mailbox.id])).rows[0]!;
  await enqueueJob(fixture.db, { workspaceId, kind: 'crm.mail_capture', idempotencyKey: key, payload: { mailboxId: mailbox.id, providerMessageId: key, providerAccountId: mailbox.provider_account_id, generation: 1, conversationId: conversation.id, controlsRevision: 1, policyRevision: 1, decisionRevision: 0 } });
  const job = (await claimJobs(fixture.db, { owner: 'negation-capture-fixture', kinds: ['crm.mail_capture'], limit: 1, leaseSeconds: 120 }))[0]!;
  const registry = registerHandlers(new HandlerRegistry(), { classifier: undefined, mail: undefined, send: undefined, research: undefined, crmMailCapture: {
    proofVerifier: { verify: async proof => proof.accountBinding === binding && proof.grantReceipt === 'fixture-grant' },
    provider: { read: async () => ({ providerAccountId: mailbox.provider_account_id, messageId: key, threadId: conversation.provider_thread_id, labels: [outgoing ? 'SENT' : 'INBOX'], origin: outgoing ? 'sent' : 'unknown', providerAt: outgoing ? '2026-10-13T13:00:00.000Z' : '2026-10-13T14:00:00.000Z', rawSenderDate: outgoing ? 'Tue, 13 Oct 2026 09:00:00 -0400' : 'Tue, 13 Oct 2026 10:00:00 -0400', from: outgoing ? mailbox.email_address : 'casey@example.test', to: [outgoing ? 'casey@example.test' : mailbox.email_address], cc: [], subject: 'Call', body: text, parserVersion: 'controlled-v1', representation: 'plain_text', completeness: 'complete', ranges: [{ start: 0, end: authoredLength, kind: 'authored' as const }, ...(authoredLength === text.length ? [] : [{ start: authoredLength, end: text.length, kind: 'quoted' as const }])] }) }
  } });
  const handler = registry.get('crm.mail_capture');
  if (!handler) throw new Error('registered capture missing');
  const result = await handler.handle({ session: fixture.db, scope: workspaceScope(workspaceId, { kind: 'system', component: 'worker' }), job });
  const sourceId = result?.progress['sourceId'];
  if (typeof sourceId !== 'string') throw new Error('canonical admission failed');
  return { sourceId, sourceRevision: 1, contentHash: createHash('sha256').update(text).digest('hex') };
}
async function configuredRequest(text: string, priorSources: Awaited<ReturnType<typeof admittedMessage>>[], authoredLength = text.length) {
  const source = await admittedMessage(text, false, authoredLength);
  const original = await post('/crm/business/mail/read', source);
  expect(original.status).toBe(200);
  const binding = (original.body as { source: { accountBinding: string } }).source.accountBinding;
  const bindings: BookingPolicyBindings = {
    ownerUserId: fixture.alpha.admin.userId,
    account: { provider: 'calcom', accountId: 'controlled-calcom', email: 'david@example.test', generation: 1 },
    event: { eventTypeId: 20, bookingUrl: 'https://cal.com/controlled/demo', configurationRevision: 'controlled-event-v1' },
    calendars: [{ credentialId: 1, externalId: 'controlled-freebusy' }],
    source: { scopeRevision: 'controlled-booking-scope-v1', dataScope: 'necessary_booking_context_attendee_selected_freebusy', dataHandlingVersion: 'booking-minimized-v1' },
    sender: { channel: 'email', accountId: binding, authorityRevision: 'controlled-sender-v1' },
    model: { providerKey: 'aws_bedrock', route: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', modelVersion: 'anthropic.claude-haiku-4-5-20251001-v1:0', accountBinding: 'controlled-model-account', consentRevision: 'controlled-purpose-consent-v1', purpose: 'booking_interpretation', qualityReviewRevision: 'controlled-quality-v1', selection: 'initial_haiku' },
    budget: { lane: 'booking', timeZone: 'America/New_York', dailyCeilingCents: 200, monthlyCeilingCents: 2500 }
  };
  expect((await post('/meetings/booking-policy', command({ action: 'save', expectedRevision: 0, bindings }))).status).toBe(200);
  const runtime: BookingPolicyRuntime = { now: () => new Date().toISOString(), readEvidence: async (_context, observed) => ({ evidenceKind: 'controlled', binding: observed, verifiedAt: '2026-10-13T00:00:00Z', validUntil: '2099-01-01T00:00:00Z', accountAccess: false, calendarFreeBusy: false, eventSettings: false, modelConsent: true, modelAcceptance: true, senderAuthority: false, sourceAuthority: true, providerAdapter: false, releaseReady: false, funding: { status: 'verified', sharedRemainingDailyCents: 200, sharedRemainingMonthlyCents: 2500 } }) };
  authority = createBookingInterpretationAuthority(runtime);
  const requested = await post('/crm/booking/interpretation/request', command({ source, priorSources }));
  expect(requested.body).toMatchObject({ result: { state: 'pending', reason: null } });
  return { source, requestId: (requested.body as { result: { requestId: string } }).result.requestId };
}
async function executeCandidate(candidate: unknown) {
  const model = createBookingInterpretationModel({ accountBinding: 'controlled-model-account', fundingVerifiedUntil: '2099-01-01T00:00:00Z', surface: { endpointId: 'bedrock-runtime.us-east-1.amazonaws.com', converse: async () => ({ stopReason: 'end_turn', usage: { inputTokens: 40, outputTokens: 20 }, output: { message: { role: 'assistant', content: [{ text: JSON.stringify(candidate) }] } } }) } });
  const registry = registerHandlers(new HandlerRegistry(), { classifier: undefined, mail: undefined, send: undefined, research: undefined, bookingInterpretation: { ...(authority ? { authority } : {}), model } });
  await runOnce(fixture.db, { registry, owner: 'controlled-negation-interpreter', limit: 20 });
}
const offer = 'Can you meet on 2026-10-20 at 14:00 America/New_York?';
const affirmative = 'Yes, that works.';
async function interpret(text: string, quote: string, authoredLength = text.length, intent: 'accept_slot' | 'interest' = 'accept_slot') {
  const prior = await admittedMessage(offer, true);
  const { source, requestId } = await configuredRequest(text, [prior], authoredLength);
  const start = text.indexOf(quote);
  await executeCandidate({ intent, agreement: { sourceId: source.sourceId, start, end: start + quote.length, quote }, slot: intent === 'interest' ? null : { localDate: '2026-10-20', localTime: '14:00', timeZone: 'America/New_York', evidence: { sourceId: prior.sourceId, start: 0, end: offer.length, quote: offer } }, substantive: null });
  const visible = await post('/crm/booking/interpretation/read', { requestId });
  expect(visible.status).toBe(200);
  expect(visible.body).toMatchObject({ state: 'complete', financial: { state: 'settled', settledCents: 1 } });
  return visible.body;
}
it.each([
  ['Yes, that works. Actually, do not book it.', affirmative],
  ['Please do not book this call', 'book this call'],
  ["Yes, that works. Actually, don't book it.", affirmative],
  ['Yes, that works. Please don’t schedule this call.', affirmative],
  ['Yes, that works. Do not arrange this meeting.', affirmative]
])('withholds a cropped positive slot candidate when the whole authored reply negates booking: %s', async (text, quote) => {
  expect(await interpret(text, quote)).toMatchObject({ outcome: { kind: 'clarification', reason: 'booking_candidate_requires_review', permission: false } });
});
it('withholds a booking-link candidate despite a cropped affirmative before booking negation', async () => {
  expect(await interpret('Yes, that works. Actually, do not book it.', affirmative, undefined, 'interest')).toMatchObject({ outcome: { kind: 'clarification', permission: false } });
});
it('withholds cropped booking interest from an explicit request not to book this call', async () => {
  expect(await interpret('Please do not book this call', 'book this call', undefined, 'interest')).toMatchObject({ outcome: { kind: 'clarification', permission: false } });
});
it('preserves ordinary agreement to a unique prior outgoing offer', async () => {
  expect(await interpret(affirmative, affirmative)).toMatchObject({ outcome: { kind: 'slot_proposal', permission: false, attendeeAddress: 'casey@example.test' } });
});
it('does not treat a quoted booking negation as authored contradiction', async () => {
  expect(await interpret(`${affirmative}\n> Please do not book this call`, affirmative, affirmative.length)).toMatchObject({ outcome: { kind: 'slot_proposal', permission: false } });
});
