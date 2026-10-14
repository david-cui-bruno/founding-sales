import { createHash, randomUUID } from 'node:crypto';
import {createElement} from 'react';
import {cleanup,render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {EmailTimeline,type EmailTimelinePorts} from '../../desktop/src/renderer/firms/EmailTimeline.tsx';
import {bookingConversationViewSchema,bookingPolicySettingsViewSchema} from '@fss/contracts';
import type {BookingConversationRuntime} from '@fss/domain/meetings/bookingConversation.ts';
import {createAuthedClient} from '../../desktop/src/main/authedClient.ts';
import {OPERATIONS} from '../../desktop/src/shared/operations.ts';
import {answerOperation,operationHandlers,type OperationHostDeps} from '../../desktop/src/main/operationHost.ts';
import { afterAll, afterEach, beforeEach, expect, it,vi } from 'vitest';
import {mailSourceListSchema,mailConversationSchema,mailConversationV2Schema,bookingInterpretationViewSchema,wireDrift} from '@fss/contracts';
const domEnvironment=vi.hoisted(async()=>{
 const {createRequire}=await import('node:module');
 const {JSDOM}:{JSDOM:new(html:string,options:{url:string})=>{window:Window&typeof globalThis}}=createRequire(import.meta.url)('jsdom');
 const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost'});
 const values={window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle};
 const descriptors=new Map(Object.keys(values).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 for(const [key,value] of Object.entries(values))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
 return {restore:()=>{for(const [key,descriptor] of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}dom.window.close();}};
});
afterAll(async()=>{(await domEnvironment).restore();});
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
import type {SessionQueryable,QueryResultRowLike} from '@fss/domain/db/queryable.ts';
import {recordProviderCall} from '@fss/domain/research/ledger.ts';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

let fixture: AuthFixture;
let token: string;
const command = (body: object) => ({ commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, ...body });
let authority:BookingInterpretationAuthorityPort|undefined;
const post = (path: string, body: unknown) => dispatch({ method: 'POST', path, body,
  query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` } },
{ session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false,...authority===undefined?{}:{bookingInterpretationAuthority:authority} }).then(response=>{
 if(response.status===200&&path.startsWith('/crm/booking/interpretation/')){
  const envelope=response.body as {result?:unknown};
  expect(wireDrift(bookingInterpretationViewSchema,envelope.result??response.body)).toEqual([]);
 }
 return response;
});

/** Controlled canonical capture proves source provenance, not actual Gmail or booking consent. */
async function admittedMessage(text: string,outgoing=false,authoredLength=text.length,outgoingTo='casey@example.test') {
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
      provider: { read: async () => ({ providerAccountId: mailbox.provider_account_id, messageId: key, threadId: conversation.provider_thread_id, labels: [outgoing?'SENT':'INBOX'], origin:outgoing?'sent':'unknown', providerAt: outgoing?'2026-10-13T13:00:00.000Z':'2026-10-13T14:00:00.000Z', rawSenderDate: outgoing?'Tue, 13 Oct 2026 09:00:00 -0400':'Tue, 13 Oct 2026 10:00:00 -0400', from: outgoing?mailbox.email_address:'casey@example.test', to: [outgoing?outgoingTo:mailbox.email_address], cc: [], subject: 'Call', body: text, parserVersion: 'controlled-v1', representation: 'plain_text', completeness: 'complete', ranges: [{ start: 0, end: authoredLength, kind: 'authored' as const },...(authoredLength===text.length?[]:[{start:authoredLength,end:text.length,kind:'quoted' as const}])] }) } } });
  const handler = registry.get('crm.mail_capture');
  if (!handler) throw new Error('registered capture missing');
  const result = await handler.handle({ session: fixture.db, scope: workspaceScope(workspaceId, { kind: 'system', component: 'worker' }), job });
  const sourceId = result?.progress['sourceId'];
  if (typeof sourceId !== 'string') throw new Error('canonical admission failed');
  return { sourceId, sourceRevision: 1, contentHash: createHash('sha256').update(text).digest('hex') };
}

beforeEach(async () => { authority=undefined;fixture = await createAuthFixture(); token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken; });
afterEach(async () => { cleanup();await fixture.stop(); });

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

async function configuredRequest(text:string,priorSources:Awaited<ReturnType<typeof admittedMessage>>[]=[],sharedRemainingDailyCents=200,authoredLength=text.length,validUntil:()=>string=()=> '2099-01-01T00:00:00Z',modelConsent:()=>boolean=()=>true) {
 const source=await admittedMessage(text,false,authoredLength);
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
 const runtime:BookingPolicyRuntime={now:()=>new Date().toISOString(),readEvidence:async(_context,observed)=>({evidenceKind:'controlled',binding:observed,verifiedAt:'2026-10-13T00:00:00Z',validUntil:validUntil(),accountAccess:false,calendarFreeBusy:false,eventSettings:false,modelConsent:modelConsent(),modelAcceptance:true,senderAuthority:false,sourceAuthority:true,providerAdapter:false,releaseReady:false,funding:{status:'verified',sharedRemainingDailyCents,sharedRemainingMonthlyCents:2500}})};
 authority=createBookingInterpretationAuthority(runtime);
 const requested=await post('/crm/booking/interpretation/request',command({source,priorSources}));
 expect(requested.body).toMatchObject({result:{state:'pending',reason:null}});
 const requestId=(requested.body as {result:{requestId:string}}).result.requestId;
 return {source,requestId,runtime,bindings};
}
async function executeCandidate(candidate:unknown,afterWait?:()=>Promise<void>,unknown=false,observeWire?:(wire:unknown)=>void,session:SessionQueryable=fixture.db,maxInputBound?:number) {
 const model=createBookingInterpretationModel({accountBinding:'controlled-model-account',fundingVerifiedUntil:'2099-01-01T00:00:00Z',surface:{endpointId:'bedrock-runtime.us-east-1.amazonaws.com',converse:async wire=>{observeWire?.(wire);await afterWait?.();return unknown?{}:{stopReason:'end_turn',usage:{inputTokens:40,outputTokens:20},output:{message:{role:'assistant',content:[{text:JSON.stringify(candidate)}]}}};}}});
 const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,bookingInterpretation:{...(authority===undefined?{}:{authority}),model:maxInputBound===undefined?model:{...model,inputBound:()=>maxInputBound}}});
 await runOnce(session,{registry,owner:'controlled-booking-interpreter',limit:20});
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
it('pauses conditional scheduling and gives David an actionable original sales-question handoff',async()=>{
 const text='If it costs under $500, we can arrange a call. What does it cost?';const {source,requestId}=await configuredRequest(text);
 const question='What does it cost?';const start=text.indexOf(question);
 await executeCandidate({intent:'conditional',agreement:{sourceId:source.sourceId,start:0,end:text.length,quote:text},slot:null,substantive:{sourceId:source.sourceId,start,end:text.length,quote:question}});
 expect((await post('/crm/booking/interpretation/read',{requestId})).body).toMatchObject({state:'complete',outcome:{kind:'david_handoff',schedulingPaused:true,permission:false,handoff:{ownerUserId:fixture.alpha.admin.userId,action:'answer_sales_question',evidence:{sourceId:source.sourceId,quote:question}}}});
});
it('separates an unconditional accepted prior slot from a durable original sales-question handoff',async()=>{
 const offer='Can you meet on 2026-10-20 at 14:00 America/New_York?';const prior=await admittedMessage(offer,true);
 const agreement='Yes, that works for me.';const question='What does it cost?';const text=`${agreement} ${question}`;
 const {source,requestId}=await configuredRequest(text,[prior]);
 await executeCandidate({intent:'accept_slot',agreement:{sourceId:source.sourceId,start:0,end:agreement.length,quote:agreement},slot:{localDate:'2026-10-20',localTime:'14:00',timeZone:'America/New_York',evidence:{sourceId:prior.sourceId,start:0,end:offer.length,quote:offer}},substantive:{sourceId:source.sourceId,start:agreement.length+1,end:text.length,quote:question}});
 expect((await post('/crm/booking/interpretation/read',{requestId})).body).toMatchObject({state:'complete',outcome:{kind:'slot_proposal',permission:false,schedulingPaused:false,handoff:{ownerUserId:fixture.alpha.admin.userId,action:'answer_sales_question',evidence:{sourceId:source.sourceId,quote:question}}}});
});
it('conservatively settles unknown model acceptance and refuses a new charge for the same original',async()=>{
 const {source,requestId}=await configuredRequest('Can we arrange a call?');
 await executeCandidate(null,undefined,true);
 const visible=await post('/crm/booking/interpretation/read',{requestId});
 expect(visible.body).toMatchObject({state:'unknown_acceptance',outcome:null,financial:{state:'estimated'}});
 const retry=await post('/crm/booking/interpretation/request',command({source,priorSources:[]}));
 expect(retry.body).toMatchObject({result:{state:'unavailable',reason:'prior_model_acceptance_unresolved'}});
});
async function concurrentCommand(path:string,body:unknown){
 const session=await fixture.database.appRuntimeSession();
 return dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session,auth:{...fixture.deps,db:session},supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
}
it('commits model calling before the wait and hides outcomes when the owner revokes policy on another connection',async()=>{
 const text='Can we arrange a call?';const {source,requestId}=await configuredRequest(text);
 await executeCandidate({intent:'interest',agreement:{sourceId:source.sourceId,start:0,end:text.length,quote:text},slot:null,substantive:null},async()=>{
  const receipt=(await fixture.db.query('SELECT state FROM provider_reservations WHERE subject_id=$1',[requestId])).rows[0];expect(receipt).toMatchObject({state:'calling'});
  expect((await concurrentCommand('/meetings/booking-policy',command({action:'revoke',expectedRevision:1}))).status).toBe(200);
 });
 expect((await post('/crm/booking/interpretation/read',{requestId})).body).toMatchObject({state:'unavailable',reason:'booking_authority_changed',outcome:null,financial:{state:'settled',settledCents:1}});
});
it('source deletion during the model wait redacts every derived quote and retains only source-free accounting',async()=>{
 const text='Can we arrange a call?';const {source,requestId}=await configuredRequest(text);
 await executeCandidate({intent:'interest',agreement:{sourceId:source.sourceId,start:0,end:text.length,quote:text},slot:null,substantive:null},async()=>{
  expect((await concurrentCommand('/crm/business/mail/delete',command({sourceId:source.sourceId,expectedRevision:source.sourceRevision}))).status).toBe(200);
 });
 expect((await post('/crm/booking/interpretation/read',{requestId})).body).toMatchObject({state:'stale',outcome:null,provenance:null,financial:{state:'settled',settledCents:1}});
 const stored=(await fixture.db.query('SELECT outcome,provenance,authority_snapshot FROM crm_booking_interpretations WHERE id=$1',[requestId])).rows[0];expect(stored).toEqual({outcome:null,provenance:null,authority_snapshot:null});
});
it('does not call the model when its full maximum reservation exceeds stricter shared allowance',async()=>{
 const {requestId}=await configuredRequest(`Can we arrange a call? ${'necessary context '.repeat(400)}`,[],1);let calls=0;
 await executeCandidate(null,async()=>{calls++;});
 expect(calls).toBe(0);
 expect((await post('/crm/booking/interpretation/read',{requestId})).body).toMatchObject({state:'unavailable',reason:'booking_budget_unavailable',financial:null});
});
it('does not promote generic interest to agreement just because a model labels it accept_slot',async()=>{
 const offer='Can you meet on 2026-10-20 at 14:00 America/New_York?';const prior=await admittedMessage(offer,true);
 const text='I am interested in learning more.';const {source,requestId}=await configuredRequest(text,[prior]);
 await executeCandidate({intent:'accept_slot',agreement:{sourceId:source.sourceId,start:0,end:text.length,quote:text},slot:{localDate:'2026-10-20',localTime:'14:00',timeZone:'America/New_York',evidence:{sourceId:prior.sourceId,start:0,end:offer.length,quote:offer}},substantive:null});
 expect((await post('/crm/booking/interpretation/read',{requestId})).body).toMatchObject({state:'complete',outcome:{kind:'clarification',permission:false}});
});
it('revalidates unresolved acceptance when a second request was queued before the first model wait',async()=>{
 const {source}=await configuredRequest('Can we arrange a call?');
 const queued=await post('/crm/booking/interpretation/request',command({source,priorSources:[]}));
 const requestId=(queued.body as {result:{requestId:string}}).result.requestId;let calls=0;
 await executeCandidate(null,async()=>{calls++;},true);
 expect(calls).toBe(1);
 expect((await post('/crm/booking/interpretation/read',{requestId})).body).toMatchObject({state:'unavailable',reason:'prior_model_acceptance_unresolved',financial:null});
});
it('recovers a lost calling lease with maximum settlement and never replays the provider attempt',async()=>{
 const text='Can we arrange a call?';const {source,requestId}=await configuredRequest(text);
 let entered!:()=>void,release!:()=>void,calls=0;const started=new Promise<void>(resolve=>{entered=resolve;});const held=new Promise<void>(resolve=>{release=resolve;});
 const model=createBookingInterpretationModel({accountBinding:'controlled-model-account',fundingVerifiedUntil:'2099-01-01T00:00:00Z',surface:{endpointId:'bedrock-runtime.us-east-1.amazonaws.com',converse:async()=>{calls++;entered();await held;return {stopReason:'end_turn',usage:{inputTokens:40,outputTokens:20},output:{message:{role:'assistant',content:[{text:JSON.stringify({intent:'interest',agreement:{sourceId:source.sourceId,start:0,end:text.length,quote:text},slot:null,substantive:null})}]}}};}}});
 const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,bookingInterpretation:{...(authority===undefined?{}:{authority}),model}});
 const original=runOnce(fixture.db,{registry,owner:'lost-interpreter',limit:20});await started;
 const second=await fixture.database.appRuntimeSession();
 await second.query("UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE kind='crm.booking_interpretation' AND state='running'");
 await runOnce(second,{registry,owner:'recovering-interpreter',limit:20});release();await original;
 expect(calls).toBe(1);
 const visible=(await post('/crm/booking/interpretation/read',{requestId})).body;
 expect(visible).toMatchObject({state:'unknown_acceptance',reason:'model_call_not_replayed',outcome:null,financial:{state:'estimated'}});
 const financial=(visible as {financial:{reservedCents:number;settledCents:number}}).financial;expect(financial.settledCents).toBe(financial.reservedCents);
});
for(const extraFields of [false,true])it(`normal closed desktop host, authenticated API and registered worker render a current proposal in the mounted admitted-message timeline (informational fields: ${extraFields})`,async()=>{
 const text='Can we arrange a call?';const {source}=await configuredRequest(text);
 const paths:string[]=[];
 const api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:CURRENT_CLIENT_VERSION,accessToken:async()=>({token,generation:1}),send:async(url,init)=>{
  const path=new URL(url).pathname;paths.push(path);
  const response=await dispatch({method:init.method as 'POST',path,headers:init.headers,body:JSON.parse(init.body??'{}') as unknown,query:new URLSearchParams()},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,bookingInterpretationAuthority:authority!});
  if(path.startsWith('/crm/booking/interpretation/')){
   const envelope=response.body as {result?:unknown};
   expect(wireDrift(bookingInterpretationViewSchema,envelope.result??response.body)).toEqual([]);
  }
  if(!extraFields||!path.startsWith('/crm/booking/interpretation/'))return response;
  const envelope=response.body as {result?:unknown};
  const view=bookingInterpretationViewSchema.parse(envelope.result??response.body);
  const extended={...view,informational:'new server detail',outcome:view.outcome?{...view.outcome,informational:'outcome detail'}:null,provenance:view.provenance?{...view.provenance,informational:'provenance detail',source:{...view.provenance.source,informational:'source detail'}}:null,financial:view.financial?{...view.financial,informational:'finance detail'}:null};
  expect(wireDrift(bookingInterpretationViewSchema,extended)).toContain('informational: not declared by the contract');
  return {...response,body:envelope.result?{...envelope,result:extended}:extended};
 }});
 // Unrelated operation-host capabilities are absent. The real client, closed descriptors and identity fence are used.
 const handlers=operationHandlers({api,recordings:{identity:{current:()=>1}}} as unknown as OperationHostDeps);
 const ports:EmailTimelinePorts={
  list:async input=>mailSourceListSchema.parse(await answerOperation(handlers,'read','crm.businessMailList',input)),
  read:async input=>mailConversationSchema.parse(await answerOperation(handlers,'read','crm.businessMailRead',input)),
  readV2:async input=>mailConversationV2Schema.parse(await answerOperation(handlers,'read','crm.businessMailReadV2',input)),
  booking:{request:async input=>{const queued=bookingInterpretationViewSchema.parse(await answerOperation(handlers,'command','crm.bookingInterpretationRequest',input));await executeCandidate({intent:'interest',agreement:{sourceId:source.sourceId,start:0,end:text.length,quote:text},slot:null,substantive:null});return queued;},read:async input=>bookingInterpretationViewSchema.parse(await answerOperation(handlers,'read','crm.bookingInterpretationRead',input))},
 };
 const mounted=render(createElement(EmailTimeline,{enabled:true,ports,privacyKey:'current-owner',sourceVersion:1}));
 await userEvent.setup().click(await screen.findByRole('button',{name:'Open email 1'}));
 await userEvent.setup().click(await screen.findByRole('button',{name:'Interpret booking request'}));
 expect(await screen.findByText('Approved-link proposal: https://cal.com/controlled/demo')).toBeTruthy();
 expect(screen.getByText('Proposals only. This cannot send a message or create an appointment.')).toBeTruthy();
 expect(paths).toContain('/crm/booking/interpretation/request');expect(paths).toContain('/crm/booking/interpretation/read');expect(paths.some(path=>/send|create/.test(path))).toBe(false);
 mounted.rerender(createElement(EmailTimeline,{enabled:false,ports,privacyKey:'revoked-owner',sourceVersion:2}));
 expect(screen.queryByText('Approved-link proposal: https://cal.com/controlled/demo')).toBeNull();
});
it('normal mounted timeline admits a current standing conversation and records a durable reply stop through the closed desktop host',async()=>{
 const text='Can we arrange a call?';const {source,runtime}=await configuredRequest(text);
 const policy:BookingPolicyRuntime={...runtime,readEvidence:async(context,bindings)=>{const observed=await runtime.readEvidence(context,bindings);return observed===null?null:{...observed,accountAccess:true,calendarFreeBusy:true,eventSettings:true,senderAuthority:true,providerAdapter:true,releaseReady:true};}};
 const conversation:BookingConversationRuntime={policy,interpretationAuthority:authority!};
 const paths:string[]=[];
 const api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:CURRENT_CLIENT_VERSION,accessToken:async()=>({token,generation:1}),send:async(url,init)=>{
  const target=new URL(url);paths.push(target.pathname);
  const response=await dispatch({method:init.method,path:target.pathname,query:target.searchParams,headers:init.headers,body:init.body===undefined?undefined:JSON.parse(init.body) as unknown},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,bookingInterpretationAuthority:authority!,bookingConversation:conversation,bookingPolicyRuntime:policy});
  if(response.status===200&&target.pathname.startsWith('/meetings/booking-conversation')){const body=response.body as {result?:unknown};expect(wireDrift(bookingConversationViewSchema,body.result??body)).toEqual([]);}
  if(response.status===200&&target.pathname==='/meetings/booking-policy')expect(wireDrift(bookingPolicySettingsViewSchema,response.body)).toEqual([]);
  return response;
 }});
 const handlers=operationHandlers({api,recordings:{identity:{current:()=>1}}} as unknown as OperationHostDeps);
 const ports:EmailTimelinePorts={
  list:async input=>mailSourceListSchema.parse(await answerOperation(handlers,'read','crm.businessMailList',input)),
  read:async input=>mailConversationSchema.parse(await answerOperation(handlers,'read','crm.businessMailRead',input)),
  readV2:async input=>mailConversationV2Schema.parse(await answerOperation(handlers,'read','crm.businessMailReadV2',input)),
  booking:{request:async input=>{const queued=bookingInterpretationViewSchema.parse(await answerOperation(handlers,'command','crm.bookingInterpretationRequest',input));await executeCandidate({intent:'interest',agreement:{sourceId:source.sourceId,start:0,end:text.length,quote:text},slot:null,substantive:null});return queued;},read:async input=>bookingInterpretationViewSchema.parse(await answerOperation(handlers,'read','crm.bookingInterpretationRead',input))},
  bookingConversation:{policy:async()=>{const result=OPERATIONS['meetings.bookingPolicy'].output.parse(await answerOperation(handlers,'read','meetings.bookingPolicy',{}));return result.view===null?null:{revision:result.view.policy.revision,status:result.view.policy.setting.status};},request:async input=>OPERATIONS['meetings.bookingConversationRequest'].output.parse(await answerOperation(handlers,'command','meetings.bookingConversationRequest',input)),read:async input=>OPERATIONS['meetings.bookingConversationRead'].output.parse(await answerOperation(handlers,'read','meetings.bookingConversationRead',input)),event:async input=>OPERATIONS['meetings.bookingConversationEvent'].output.parse(await answerOperation(handlers,'command','meetings.bookingConversationEvent',input)),messageRequest:async input=>OPERATIONS['meetings.bookingMessageRequest'].output.parse(await answerOperation(handlers,'command','meetings.bookingMessageRequest',input)),messageRead:async input=>OPERATIONS['meetings.bookingMessageRead'].output.parse(await answerOperation(handlers,'read','meetings.bookingMessageRead',input))},
 };
 const mounted=render(createElement(EmailTimeline,{enabled:true,ports,privacyKey:'current-owner',sourceVersion:1}));
 const user=userEvent.setup();await user.click(await screen.findByRole('button',{name:'Open email 1'}));await user.click(await screen.findByRole('button',{name:'Interpret booking request'}));
 await user.click(await screen.findByRole('button',{name:'Manage booking conversation'}));
 expect(await screen.findByText('Conversation state: awaiting time')).toBeTruthy();
 expect(screen.getByText('Live booking automation held: enabled:false. Controlled source support is not provider, sender or model acceptance.')).toBeTruthy();
 await user.click(await screen.findByRole('button',{name:'Record reply and stop nudges'}));
 expect(await screen.findByText(/Nudges stopped at/)).toBeTruthy();
 expect((await fixture.db.query('SELECT nudge_count,last_reply_at,nudges_stopped_at FROM booking_conversations WHERE workspace_id=$1',[fixture.alpha.workspaceId])).rows).toEqual([{nudge_count:0,last_reply_at:expect.any(Date),nudges_stopped_at:expect.any(Date)}]);
 expect(paths).toContain('/meetings/booking-conversation');expect(paths).toContain('/meetings/booking-conversation/event');expect(paths).not.toContain('/meetings/booking-create');expect(paths).not.toContain('/meetings/booking-messages');
 mounted.rerender(createElement(EmailTimeline,{enabled:false,ports,privacyKey:'revoked-owner',sourceVersion:2}));expect(screen.queryByText('Conversation state: awaiting time')).toBeNull();
});
it('does not disclose quoted third-party content or unrelated identity data to the booking model',async()=>{
 const authored='Can we arrange a call?';const quoted=' PRIVATE THIRD PARTY INFORMATION';const text=authored+quoted;
 const {source,requestId}=await configuredRequest(text,[],200,authored.length);let wire='';
 await executeCandidate({intent:'interest',agreement:{sourceId:source.sourceId,start:0,end:authored.length,quote:authored},slot:null,substantive:null},undefined,false,value=>{wire=JSON.stringify(value);});
 expect(wire).not.toContain('PRIVATE THIRD PARTY INFORMATION');expect(wire).not.toContain('casey@example.test');expect(wire).not.toContain('originalContexts');
 expect((await post('/crm/booking/interpretation/read',{requestId})).body).toMatchObject({state:'complete',outcome:{kind:'approved_link',permission:false}});
});
for(const waitAt of ['budget','settlement'] as const)it(`withholds publication when captured authority expires across the real PG ${waitAt} wait`,async()=>{
 let deadline='2099-01-01T00:00:00Z',publishing=false,waited=false;
 const text='Can we arrange a call?';const {source,requestId}=await configuredRequest(text,[],200,text.length,()=>deadline);
 const session:SessionQueryable={query:async<Row extends QueryResultRowLike>(sql:string,values?:readonly unknown[])=>{
  const target=waitAt==='budget'?sql.includes('pg_advisory_xact_lock')&&values?.[0]===`${fixture.alpha.workspaceId}:monthly_cash_ceiling`:sql.includes('UPDATE provider_reservations')&&sql.includes('settled_cents');
  if(publishing&&!waited&&target){waited=true;await fixture.db.query('SELECT pg_sleep(0.8)');}
  return fixture.db.query<Row>(sql,values);
 }};
 await executeCandidate({intent:'interest',agreement:{sourceId:source.sourceId,start:0,end:text.length,quote:text},slot:null,substantive:null},async()=>{publishing=true;deadline=new Date(Date.now()+500).toISOString();},false,undefined,session);
 expect(waited).toBe(true);
 const row=(await fixture.db.query('SELECT state,outcome FROM crm_booking_interpretations WHERE id=$1',[requestId])).rows[0];
 expect(row).toMatchObject({state:'stale',outcome:null});
 expect((await fixture.db.query('SELECT state,settled_cents FROM provider_reservations WHERE subject_id=$1',[requestId])).rows[0]).toMatchObject({state:'settled',settled_cents:1});
});
it('publishes after conserved settlement removes this requests own last-allowance maximum hold',async()=>{
 const text='Can we arrange a call?';const {source,requestId}=await configuredRequest(text);
 await recordProviderCall({db:fixture.db,scope:workspaceScope(fixture.alpha.workspaceId,{kind:'system',component:'worker'})},{providerKey:'aws_bedrock.booking',at:new Date().toISOString(),businessTimeZone:'America/New_York',costCents:195});
 // Trusted controlled bound reserves five cents at existing pricing, not a client grant or policy credit.
 await executeCandidate({intent:'interest',agreement:{sourceId:source.sourceId,start:0,end:text.length,quote:text},slot:null,substantive:null},async()=>{
  expect((await fixture.db.query('SELECT state,cents FROM provider_reservations WHERE subject_id=$1',[requestId])).rows[0]).toMatchObject({state:'calling',cents:5});
 },false,undefined,fixture.db,35000);
 expect((await post('/crm/booking/interpretation/read',{requestId})).body).toMatchObject({state:'complete',outcome:{kind:'approved_link',permission:false},financial:{reservedCents:5,settledCents:1}});
 expect((await fixture.db.query("SELECT sum(cost_cents)::int AS cents FROM provider_ledger WHERE provider_key='aws_bedrock.booking'")).rows[0]).toMatchObject({cents:196});
});
for(const variant of ['either option','cropped agreement','single selection','single selection with quoted alternative','direct either option','single prior conflicting selection'] as const)it(`checks whole-authored incoming slot choice: ${variant}`,async()=>{
 const first='2026-10-20 at 14:00 America/New_York';const second='2026-10-21 at 15:00 America/New_York';
 const offer=variant==='single prior conflicting selection'?`Can you meet on ${first}?`:`Can you meet on ${first} or ${second}?`;const prior=variant==='direct either option'?undefined:await admittedMessage(offer,true);
 const selected=`Yes, ${first} works for me.`;
 const ambiguous=`Yes, either ${first} or ${second} works for me`;
 const positive=variant==='single selection'||variant==='single selection with quoted alternative';
 const authored=variant==='single prior conflicting selection'?`Yes, ${second} works for me.`:positive?selected:ambiguous;
 const text=variant==='single selection with quoted alternative'?`${authored}\n> ${second}`:authored;
 const {source,requestId}=await configuredRequest(text,prior?[prior]:[],200,authored.length);
 const agreement=variant==='cropped agreement'?`Yes, either ${first}`:authored;
 const evidenceSource=prior??source;const evidenceText=prior?offer:text;const start=evidenceText.indexOf(first);
 await executeCandidate({intent:'accept_slot',agreement:{sourceId:source.sourceId,start:0,end:agreement.length,quote:agreement},slot:{localDate:'2026-10-20',localTime:'14:00',timeZone:'America/New_York',evidence:{sourceId:evidenceSource.sourceId,start,end:start+first.length,quote:first}},substantive:null});
 expect((await post('/crm/booking/interpretation/read',{requestId})).body).toMatchObject({state:'complete',outcome:{kind:positive?'slot_proposal':'clarification',permission:false}});
});
it('keeps controlled model candidate inputs strict despite tolerant success response DTOs',async()=>{
 const text='Can we arrange a call?';const {source,requestId}=await configuredRequest(text);
 await executeCandidate({intent:'interest',agreement:{sourceId:source.sourceId,start:0,end:text.length,quote:text},slot:null,substantive:null,informational:'unexpected model field'});
 expect((await post('/crm/booking/interpretation/read',{requestId})).body).toMatchObject({state:'complete',outcome:{kind:'clarification',permission:false}});
});
for(const variant of ['multiple options','another recipient'] as const)it(`clarifies prior ${variant} rather than inventing a selected slot or attendee`,async()=>{
 const first='2026-10-20 at 14:00 America/New_York';const offer=variant==='multiple options'?`Can you meet on ${first} or 2026-10-21 at 15:00 America/New_York?`:`Can you meet on ${first}?`;
 const prior=await admittedMessage(offer,true,offer.length,variant==='another recipient'?'bob@example.test':'casey@example.test');
 const text='Yes, that works for me.';const {source,requestId}=await configuredRequest(text,[prior]);
 const start=offer.indexOf(first);
 await executeCandidate({intent:'accept_slot',agreement:{sourceId:source.sourceId,start:0,end:text.length,quote:text},slot:{localDate:'2026-10-20',localTime:'14:00',timeZone:'America/New_York',evidence:{sourceId:prior.sourceId,start,end:start+first.length,quote:first}},substantive:null});
 expect((await post('/crm/booking/interpretation/read',{requestId})).body).toMatchObject({state:'complete',outcome:{kind:'clarification',permission:false}});
});
it('replays only a current read after canonical source deletion, never private immutable receipt copies',async()=>{
 const source=await admittedMessage('Can we arrange a call?');const body=command({source,priorSources:[]});
 const original=await post('/crm/booking/interpretation/request',body);
 expect(original.body).toMatchObject({result:{provenance:{participant:'casey@example.test'}}});
 expect((await post('/crm/business/mail/delete',command({sourceId:source.sourceId,expectedRevision:source.sourceRevision}))).status).toBe(200);
 const replay=await concurrentCommand('/crm/booking/interpretation/request',body);
 expect(replay.body).toMatchObject({replayed:true,result:{state:'stale',provenance:null,outcome:null}});
 const stored=(await fixture.db.query('SELECT result FROM command_receipts WHERE command_id=$1',[body.commandId])).rows[0]!;
 expect(stored['result']).toEqual({requestId:(original.body as {result:{requestId:string}}).result.requestId});
});
it('does not launder a fresh model-consent refusal through the booking budget observer',async()=>{
 let consent=true,calls=0;const text='Can we arrange a call?';const {requestId}=await configuredRequest(text,[],200,text.length,undefined,()=>consent);
 const canonical=authority!;authority={...canonical,budget:async(context,snapshot)=>{consent=false;return canonical.budget(context,snapshot);}};
 await executeCandidate(null,async()=>{calls++;});
 expect(calls).toBe(0);
 expect((await fixture.db.query('SELECT count(*)::int AS n FROM provider_reservations WHERE subject_id=$1',[requestId])).rows[0]).toMatchObject({n:0});
});
it('replays source reassociation as a current stale view instead of old original-context provenance',async()=>{
 const source=await admittedMessage('Can we arrange a call?');const body=command({source,priorSources:[]});
 expect((await post('/crm/booking/interpretation/request',body)).status).toBe(200);
 const firm=(await fixture.db.query<{id:string}>("INSERT INTO firms(workspace_id,name,assigned_user_id) VALUES($1,'Current reviewed firm',$2) RETURNING id",[fixture.alpha.workspaceId,fixture.alpha.admin.userId])).rows[0]!;
 expect((await post('/crm/business/mail/associate',command({sourceId:source.sourceId,expectedRevision:1,firmId:firm.id}))).status).toBe(200);
 expect((await concurrentCommand('/crm/booking/interpretation/request',body)).body).toMatchObject({replayed:true,result:{state:'stale',provenance:null,outcome:null}});
});
it('refuses private current read after session loss inside canonical authority wait',async()=>{
 const {requestId}=await configuredRequest('Can we arrange a call?');const canonical=authority!;
 authority={...canonical,revalidate:async(context,snapshot)=>{
  const current=await canonical.revalidate(context,snapshot);
  const other=await fixture.database.appRuntimeSession();
  await other.query("UPDATE sessions SET status='ended',ended_at=now(),end_reason='signed_out' WHERE workspace_id=$1 AND user_id=$2 AND status='active'",[fixture.alpha.workspaceId,fixture.alpha.admin.userId]);
  return current;
 }};
 const response=await post('/crm/booking/interpretation/read',{requestId});
 expect(response.status).toBe(404);expect(JSON.stringify(response.body)).not.toContain('casey@example.test');
});
it('releases the owned uncalled hold when captured authority expires across the real reserve COMMIT wait',async()=>{
 const text='Can we arrange a call?';const {requestId}=await configuredRequest(text,[],200,text.length,()=>new Date(Date.now()+500).toISOString());
 let processing=false,waited=false,calls=0;
 const session:SessionQueryable={query:async<Row extends QueryResultRowLike>(sql:string,values?:readonly unknown[])=>{
  const result=await fixture.db.query<Row>(sql,values);
  if(sql.includes("SET state='processing'"))processing=true;
  if(processing&&!waited&&sql==='COMMIT'){waited=true;await fixture.db.query('SELECT pg_sleep(0.8)');}
  return result;
 }};
 await executeCandidate(null,async()=>{calls++;},false,undefined,session);
 expect(waited).toBe(true);expect(calls).toBe(0);
 expect((await fixture.db.query('SELECT state,settled_cents FROM provider_reservations WHERE subject_id=$1',[requestId])).rows[0]).toMatchObject({state:'released',settled_cents:0});
});
it('does not queue a request using a captured authority deadline expired during the canonical read wait',async()=>{
 const text='Can we arrange a call?';const {source}=await configuredRequest(text,[],200,text.length,()=>new Date(Date.now()+500).toISOString());
 const canonical=authority!;authority={...canonical,read:async(context,query)=>{const current=await canonical.read(context,query);await fixture.db.query('SELECT pg_sleep(0.8)');return current;}};
 const response=await post('/crm/booking/interpretation/request',command({source,priorSources:[]}));
 expect(response.body).toMatchObject({result:{state:'unavailable'}});
 const requestId=(response.body as {result:{requestId:string}}).result.requestId;
 expect((await fixture.db.query("SELECT count(*)::int AS n FROM jobs WHERE kind='crm.booking_interpretation' AND payload->>'requestId'=$1",[requestId])).rows[0]).toMatchObject({n:0});
});
it('hides a current candidate when captured authority expires during the final canonical read wait',async()=>{
 const text='Can we arrange a call?';const {source,requestId}=await configuredRequest(text,[],200,text.length,()=>new Date(Date.now()+500).toISOString());
 await executeCandidate({intent:'interest',agreement:{sourceId:source.sourceId,start:0,end:text.length,quote:text},slot:null,substantive:null});
 const canonical=authority!;authority={...canonical,revalidate:async(context,snapshot)=>{const current=await canonical.revalidate(context,snapshot);await fixture.db.query('SELECT pg_sleep(0.8)');return current;}};
 expect((await post('/crm/booking/interpretation/read',{requestId})).body).toMatchObject({state:'unavailable',outcome:null,reason:'booking_authority_changed'});
});
