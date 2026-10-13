import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { enqueueJob, claimJobs } from '@fss/domain/jobs/jobStore.ts';
import { businessAccountBinding } from '@fss/domain/business/acquisition.ts';
import { workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { registerHandlers } from '../../worker/src/bootstrap/main.ts';
import { runOnce } from '../../worker/src/runner/jobRunner.ts';
import {createBookingInterpretationModel} from '../../worker/src/providers/bookingInterpretationModel.ts';
import {createBookingInterpretationAuthority} from '@fss/domain/crm/bookingInterpretationAuthority.ts';
import type {BookingPolicyBindings} from '@fss/contracts';
import type {BookingPolicyRuntime} from '@fss/domain/meetings/bookingPolicyTypes.ts';
import type {BookingInterpretationAuthorityPort} from '@fss/domain/crm/bookingInterpretationAuthority.ts';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

let fixture: AuthFixture;
let token: string;
const command = (body: object) => ({ commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, ...body });
let authority:BookingInterpretationAuthorityPort|undefined;
const post = (path: string, body: unknown) => dispatch({ method: 'POST', path, body,
  query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` } },
{ session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false,...authority===undefined?{}:{bookingInterpretationAuthority:authority} });

/** Controlled canonical capture proves source provenance, not actual Gmail or booking consent. */
async function admittedMessage(text: string,outgoing=false) {
  const workspaceId = fixture.alpha.workspaceId, ownerUserId = fixture.alpha.admin.userId;
  const key = randomUUID();
  let mailbox=(await fixture.db.query<{ id: string; owner_user_id: string; email_address: string; provider_account_id: string; generation: number; status: string }>('SELECT * FROM mailboxes WHERE workspace_id=$1 AND owner_user_id=$2',[workspaceId,ownerUserId])).rows[0];
  const fresh=mailbox===undefined;
  mailbox??=(await fixture.db.query<{ id: string; owner_user_id: string; email_address: string; provider_account_id: string; generation: number; status: string }>(
    "INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,$3,$4,'connected') RETURNING *",
    [workspaceId, ownerUserId, `${key}@example.test`, key])).rows[0]!;
  const binding = businessAccountBinding(workspaceId, mailbox)!;
  if(fresh){
  await fixture.db.query("INSERT INTO crm_business_policies(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled) VALUES($1,$2,$3,$4,$5,1,1,false)", [workspaceId, mailbox.id, ownerUserId, key, binding]);
  await fixture.db.query<{ id: string }>(
    "INSERT INTO crm_business_conversations(workspace_id,mailbox_id,owner_user_id,account_binding,provider_thread_id,subject,participants,latest_provider_at,category,reason,classifier_version,metadata_hash) VALUES($1,$2,$3,$4,$5,'Business','[]',now(),'business','fixture','fixture',$6) RETURNING id",
    [workspaceId, mailbox.id, ownerUserId, binding, key, 'a'.repeat(64)]);
  await fixture.db.query("INSERT INTO crm_mail_capture_controls(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled,policy_revision,disclosure_version,disclosure_sha256,grant_receipt,provider_policy_receipt,evaluation_receipt,release_receipt) VALUES($1,$2,$3,$4,$5,1,1,true,1,'controlled-capture',$6,'fixture-grant','fixture-provider','fixture-evaluation','fixture-release')", [workspaceId, mailbox.id, ownerUserId, key, binding, 'b'.repeat(64)]);
  }
  const conversation=(await fixture.db.query<{id:string;provider_thread_id:string}>('SELECT id,provider_thread_id FROM crm_business_conversations WHERE workspace_id=$1 AND mailbox_id=$2',[workspaceId,mailbox.id])).rows[0]!;
  const conversationId=conversation.id;
  await enqueueJob(fixture.db, { workspaceId, kind: 'crm.mail_capture', idempotencyKey: key,
    payload: { mailboxId: mailbox.id, providerMessageId: key, providerAccountId: mailbox.provider_account_id, generation: 1, conversationId, controlsRevision: 1, policyRevision: 1, decisionRevision: 0 } });
  const job = (await claimJobs(fixture.db, { owner: 'booking-capture-fixture', kinds: ['crm.mail_capture'], limit: 1, leaseSeconds: 120 }))[0]!;
  const registry = registerHandlers(new HandlerRegistry(), { classifier: undefined, mail: undefined, send: undefined, research: undefined,
    crmMailCapture: { proofVerifier: { verify: async proof => proof.accountBinding === binding && proof.grantReceipt === 'fixture-grant' },
      provider: { read: async () => ({ providerAccountId: mailbox.provider_account_id, messageId: key, threadId: conversation.provider_thread_id, labels: [outgoing?'SENT':'INBOX'], origin:outgoing?'sent':'unknown', providerAt: outgoing?'2026-10-13T13:00:00.000Z':'2026-10-13T14:00:00.000Z', rawSenderDate: outgoing?'Tue, 13 Oct 2026 09:00:00 -0400':'Tue, 13 Oct 2026 10:00:00 -0400', from: outgoing?mailbox.email_address:'casey@example.test', to: [outgoing?'casey@example.test':mailbox.email_address], cc: [], subject: 'Call', body: text, parserVersion: 'controlled-v1', representation: 'plain_text', completeness: 'complete', ranges: [{ start: 0, end: text.length, kind: 'authored' }] }) } } });
  const handler = registry.get('crm.mail_capture');
  if (!handler) throw new Error('registered capture missing');
  const result = await handler.handle({ session: fixture.db, scope: workspaceScope(workspaceId, { kind: 'system', component: 'worker' }), job });
  const sourceId = result?.progress['sourceId'];
  if (typeof sourceId !== 'string') throw new Error('canonical admission failed');
  return { sourceId, sourceRevision: 1, contentHash: createHash('sha256').update(text).digest('hex') };
}

beforeEach(async () => { authority=undefined;fixture = await createAuthFixture(); token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken; });
afterEach(async () => { await fixture.stop(); });

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

async function configuredRequest(text:string,priorSources:Awaited<ReturnType<typeof admittedMessage>>[]=[]) {
 const source=await admittedMessage(text);
 const original=await post('/crm/business/mail/read',source);
 const binding=(original.body as {source:{accountBinding:string}}).source.accountBinding;
 const bindings:BookingPolicyBindings={ownerUserId:fixture.alpha.admin.userId,
  account:{provider:'calcom',accountId:'controlled-calcom',email:'david@example.test',generation:1},
  event:{eventTypeId:20,bookingUrl:'https://cal.com/controlled/demo',configurationRevision:'controlled-event-v1'},
  calendars:[{credentialId:1,externalId:'controlled-freebusy'}],
  source:{scopeRevision:'controlled-booking-scope-v1',dataScope:'necessary_booking_context_attendee_selected_freebusy',dataHandlingVersion:'booking-minimized-v1'},
  sender:{channel:'email',accountId:binding,authorityRevision:'controlled-sender-v1'},
  model:{providerKey:'aws_bedrock',route:'us.anthropic.claude-haiku-4-5-20251001-v1:0',modelVersion:'anthropic.claude-haiku-4-5-20251001-v1:0',accountBinding:'controlled-model-account',consentRevision:'controlled-purpose-consent-v1',purpose:'booking_interpretation',qualityReviewRevision:'controlled-quality-v1',selection:'initial_haiku'},
  budget:{lane:'booking',timeZone:'America/New_York',dailyCeilingCents:200,monthlyCeilingCents:2500}};
 expect((await post('/meetings/booking-policy',command({action:'save',expectedRevision:0,bindings}))).status).toBe(200);
 const runtime:BookingPolicyRuntime={now:()=>new Date().toISOString(),readEvidence:async(_context,observed)=>({evidenceKind:'controlled',binding:observed,verifiedAt:'2026-10-13T00:00:00Z',validUntil:'2099-01-01T00:00:00Z',accountAccess:false,calendarFreeBusy:false,eventSettings:false,modelConsent:true,modelAcceptance:true,senderAuthority:false,sourceAuthority:true,providerAdapter:false,releaseReady:false,funding:{status:'verified',sharedRemainingDailyCents:200,sharedRemainingMonthlyCents:2500}})};
 authority=createBookingInterpretationAuthority(runtime);
 const requested=await post('/crm/booking/interpretation/request',command({source,priorSources}));
 expect(requested.body).toMatchObject({result:{state:'pending',reason:null}});
 const requestId=(requested.body as {result:{requestId:string}}).result.requestId;
 return {source,requestId};
}
async function executeCandidate(candidate:unknown,afterWait?:()=>Promise<void>,unknown=false) {
 const model=createBookingInterpretationModel({accountBinding:'controlled-model-account',fundingVerifiedUntil:'2099-01-01T00:00:00Z',surface:{endpointId:'bedrock-runtime.us-east-1.amazonaws.com',converse:async()=>{await afterWait?.();return unknown?{}:{stopReason:'end_turn',usage:{inputTokens:40,outputTokens:20},output:{message:{role:'assistant',content:[{text:JSON.stringify(candidate)}]}}};}}});
 const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,bookingInterpretation:{authority,model}});
 await runOnce(fixture.db,{registry,owner:'controlled-booking-interpreter',limit:20});
}
it('normal owner policy save and registered controlled Haiku worker show an approved-link proposal with original provenance and conserved spend',async()=>{
 const text='Can we arrange a call?';const {source,requestId}=await configuredRequest(text);
 await executeCandidate({intent:'interest',agreement:{sourceId:source.sourceId,start:0,end:text.length,quote:text},slot:null,substantive:null});
 const visible=await post('/crm/booking/interpretation/read',{requestId});
 expect(visible.body).toMatchObject({state:'complete',outcome:{kind:'approved_link',bookingUrl:'https://cal.com/controlled/demo',permission:false},provenance:{source,participant:'casey@example.test',occurredAt:'2026-10-13T14:00:00.000Z'},financial:{state:'settled',settledCents:1}});
 authority=undefined;
});
it('preserves an authored opt-out as a stop outcome instead of a scheduling proposal',async()=>{
 const text='Please do not contact me again.';const {source,requestId}=await configuredRequest(text);
 await executeCandidate({intent:'opt_out',agreement:{sourceId:source.sourceId,start:0,end:text.length,quote:text},slot:null,substantive:null});
 expect((await post('/crm/booking/interpretation/read',{requestId})).body).toMatchObject({state:'complete',outcome:{kind:'stop',reason:'opt_out',permission:false,evidence:{sourceId:source.sourceId,quote:text}}});
});
it('accepts the exact previously offered date time and zone without demanding a literal restatement',async()=>{
 const offer='Can you meet on 2026-10-20 at 14:00 America/New_York?';
 const prior=await admittedMessage(offer,true);
 const text='Yes, that works for me.';const {source,requestId}=await configuredRequest(text,[prior]);
 await executeCandidate({intent:'accept_slot',agreement:{sourceId:source.sourceId,start:0,end:text.length,quote:text},slot:{localDate:'2026-10-20',localTime:'14:00',timeZone:'America/New_York',evidence:{sourceId:prior.sourceId,start:0,end:offer.length,quote:offer}},substantive:null});
 expect((await post('/crm/booking/interpretation/read',{requestId})).body).toMatchObject({state:'complete',outcome:{kind:'slot_proposal',permission:false,attendeeAddress:'casey@example.test',slot:{localDate:'2026-10-20',localTime:'14:00',timeZone:'America/New_York'},requires:['current_attendee_route','fresh_freebusy','guarded_create']}});
});
