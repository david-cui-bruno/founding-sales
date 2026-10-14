import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {expect,it} from 'vitest';
import type {BookingPolicyBindings} from '@fss/contracts';
import type {SessionQueryable,QueryResultRowLike} from '@fss/domain/db/queryable.ts';
import {workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {businessAccountBinding} from '@fss/domain/business/acquisition.ts';
import {enqueueJob,claimJobs} from '@fss/domain/jobs/jobStore.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {createBookingInterpretationAuthority,type BookingInterpretationAuthorityPort} from '@fss/domain/crm/bookingInterpretationAuthority.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {createBookingInterpretationModel} from '../../worker/src/providers/bookingInterpretationModel.ts';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';

const envelope=()=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
const requestPath='/crm/booking/interpretation/request',readPath='/crm/booking/interpretation/read';
const text='Can we arrange a call?';
function caller(f:AuthFixture,token:string,db:SessionQueryable,authority?:BookingInterpretationAuthorityPort){
 return (path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:db,auth:{...f.deps,db},supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,...(authority===undefined?{}:{bookingInterpretationAuthority:authority})});
}
/** Controlled account/admission prerequisites, followed by the real registered
 * canonical capture handler. No interpretation/source result is inserted by SQL. */
async function capturedSource(f:AuthFixture){
 const workspaceId=f.alpha.workspaceId,ownerUserId=f.alpha.admin.userId,key=randomUUID();
 const mailbox=(await f.db.query<{id:string;owner_user_id:string;email_address:string;provider_account_id:string;generation:number;status:string}>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,$3,$4,'connected') RETURNING *",[workspaceId,ownerUserId,`${key}@example.test`,key])).rows[0]!;
 const binding=businessAccountBinding(workspaceId,mailbox)!;
 await f.db.query("INSERT INTO crm_business_policies(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled) VALUES($1,$2,$3,$4,$5,1,1,false)",[workspaceId,mailbox.id,ownerUserId,key,binding]);
 const conversation=(await f.db.query<{id:string}>("INSERT INTO crm_business_conversations(workspace_id,mailbox_id,owner_user_id,account_binding,provider_thread_id,subject,participants,latest_provider_at,category,reason,classifier_version,metadata_hash) VALUES($1,$2,$3,$4,$5,'Business','[]',now(),'business','fixture','fixture',$6) RETURNING id",[workspaceId,mailbox.id,ownerUserId,binding,key,'a'.repeat(64)])).rows[0]!;
 await f.db.query("INSERT INTO crm_mail_capture_controls(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled,policy_revision,disclosure_version,disclosure_sha256,grant_receipt,provider_policy_receipt,evaluation_receipt,release_receipt) VALUES($1,$2,$3,$4,$5,1,1,true,1,'controlled-capture',$6,'fixture-grant','fixture-provider','fixture-evaluation','fixture-release')",[workspaceId,mailbox.id,ownerUserId,key,binding,'b'.repeat(64)]);
 await enqueueJob(f.db,{workspaceId,kind:'crm.mail_capture',idempotencyKey:key,payload:{mailboxId:mailbox.id,providerMessageId:key,providerAccountId:key,generation:1,conversationId:conversation.id,controlsRevision:1,policyRevision:1,decisionRevision:0}});
 const job=(await claimJobs(f.db,{owner:'interpretation-admission-capture',kinds:['crm.mail_capture'],limit:1,leaseSeconds:120}))[0]!;
 const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailCapture:{proofVerifier:{verify:async proof=>proof.accountBinding===binding&&proof.grantReceipt==='fixture-grant'},provider:{read:async()=>({providerAccountId:key,messageId:key,threadId:key,labels:['INBOX'],origin:'unknown',providerAt:'2026-10-13T14:00:00.000Z',rawSenderDate:'Tue, 13 Oct 2026 10:00:00 -0400',from:'casey@example.test',to:[mailbox.email_address],cc:[],subject:'Call',body:text,parserVersion:'controlled-v1',representation:'plain_text',completeness:'complete',ranges:[{start:0,end:text.length,kind:'authored'}]})}}});
 const handler=registry.get('crm.mail_capture');if(!handler)throw new Error('Registered capture missing');
 const result=await handler.handle({session:f.db,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});
 const sourceId=result?.progress['sourceId'];if(typeof sourceId!=='string')throw new Error('Canonical capture did not produce a source');
 return {source:{sourceId,sourceRevision:1,contentHash:createHash('sha256').update(text).digest('hex')},binding};
}
async function setup(){
 const f=await createAuthFixture();
 const owner=await issueSessionFor(f,f.alpha,f.alpha.admin,{deviceLabel:'interpretation owner'}),observer=await issueSessionFor(f,f.alpha,f.alpha.admin,{deviceLabel:'interpretation observer'});
 const db=await f.database.appRuntimeSession(),observerDb=await f.database.appRuntimeSession();
 const {source,binding}=await capturedSource(f);
 const bindings:BookingPolicyBindings={ownerUserId:f.alpha.admin.userId,account:{provider:'calcom',accountId:'controlled-calcom',email:'david@example.test',generation:1},event:{eventTypeId:20,bookingUrl:'https://cal.com/controlled/demo',configurationRevision:'controlled-event-v1'},calendars:[{credentialId:1,externalId:'controlled-freebusy'}],source:{scopeRevision:'controlled-booking-scope-v1',dataScope:'necessary_booking_context_attendee_selected_freebusy',dataHandlingVersion:'booking-minimized-v1'},sender:{channel:'email',accountId:binding,authorityRevision:'controlled-sender-v1'},model:{providerKey:'aws_bedrock',route:'us.anthropic.claude-haiku-4-5-20251001-v1:0',modelVersion:'anthropic.claude-haiku-4-5-20251001-v1:0',accountBinding:'controlled-model-account',consentRevision:'controlled-purpose-consent-v1',purpose:'booking_interpretation',qualityReviewRevision:'controlled-quality-v1',selection:'initial_haiku'},budget:{lane:'booking',timeZone:'America/New_York',dailyCeilingCents:200,monthlyCeilingCents:2500}};
 const bare=caller(f,owner.accessToken,db);
 expect((await bare('/meetings/booking-policy',{...envelope(),action:'save',expectedRevision:0,bindings})).status).toBe(200);
 let validUntil=()=> '2099-01-01T00:00:00Z';
 const authority=createBookingInterpretationAuthority({now:()=>new Date().toISOString(),readEvidence:async(_context,observed)=>({evidenceKind:'controlled',binding:observed,verifiedAt:'2026-10-13T00:00:00Z',validUntil:validUntil(),accountAccess:false,calendarFreeBusy:false,eventSettings:false,modelConsent:true,modelAcceptance:true,senderAuthority:false,sourceAuthority:true,providerAdapter:false,releaseReady:false,funding:{status:'verified',sharedRemainingDailyCents:200,sharedRemainingMonthlyCents:2500}})});
 return {f,owner,db,source,authority,call:caller(f,owner.accessToken,db,authority),observe:caller(f,observer.accessToken,observerDb),deadline:(value:()=>string)=>{validUntil=value;}};
}
async function pid(db:SessionQueryable){return (await db.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;}
async function blocked(db:SessionQueryable,waiting:number,blocking:number){
 for(let n=0;n<200;n++){
  if((await db.query<{blocked:boolean}>('SELECT $2=ANY(pg_blocking_pids($1)) AS blocked',[waiting,blocking])).rows[0]?.blocked)return;
  await delay(5);
 }
 throw new Error('Mounted request did not reach the real source or authority admission lock');
}
it.each(['source','authority'].flatMap(wait=>['sign-out','device-revoke'].map(loss=>({wait,loss}))))('request admission does not commit a request job or receipt after public $loss during a $wait wait',async({wait,loss})=>{
 const {f,owner,db,source,call,observe}=await setup();let pending:ReturnType<typeof call>|undefined;
 const command={...envelope(),source,priorSources:[]};
 try{
 const [waiting,blocking]=await Promise.all([pid(db),pid(f.db)]);
 await f.db.query('BEGIN');
 if(wait==='source')await f.db.query('SELECT source_id FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=$2 FOR UPDATE',[f.alpha.workspaceId,source.sourceId]);
 else await f.db.query('LOCK TABLE provider_ledger IN ACCESS EXCLUSIVE MODE');
 pending=call(requestPath,command);
 await blocked(f.db,waiting,blocking);
 if(loss==='sign-out')expect((await caller(f,owner.accessToken,await f.database.appRuntimeSession())('/auth/sign-out',{})).status).toBe(200);
 else expect((await observe('/devices/revoke',{deviceId:owner.deviceId})).status).toBe(200);
 await f.db.query('COMMIT');
 expect((await pending).status).toBe(404);
 expect.soft((await f.db.query('SELECT count(*)::int AS n FROM crm_booking_interpretations WHERE workspace_id=$1',[f.alpha.workspaceId])).rows[0]).toEqual({n:0});
 expect.soft((await f.db.query("SELECT count(*)::int AS n FROM jobs WHERE workspace_id=$1 AND kind='crm.booking_interpretation'",[f.alpha.workspaceId])).rows[0]).toEqual({n:0});
 expect.soft((await f.db.query('SELECT count(*)::int AS n FROM command_receipts WHERE workspace_id=$1 AND command_id=$2',[f.alpha.workspaceId,command.commandId])).rows[0]).toEqual({n:0});
 }finally{await f.db.query('ROLLBACK');await pending?.catch(()=>undefined);await f.stop();}
});
it.each(['read','replayed request'].flatMap(endpoint=>['deadline','final-auth deadline','sign-out','device-revoke'].map(change=>({endpoint,change}))))('$endpoint rechecks $change after a forwarded real PostgreSQL COMMIT response wait',async({endpoint,change})=>{
 const {f,owner,db,source,authority,call,observe,deadline}=await setup();try{
 const command={...envelope(),source,priorSources:[]};
 const requested=await call(requestPath,command);
 expect(requested.body).toMatchObject({result:{state:'pending'}});
 const requestId=(requested.body as {result:{requestId:string}}).result.requestId;
 const candidate={intent:'interest',agreement:{sourceId:source.sourceId,start:0,end:text.length,quote:text},slot:null,substantive:null};
 const model=createBookingInterpretationModel({accountBinding:'controlled-model-account',fundingVerifiedUntil:'2099-01-01T00:00:00Z',surface:{endpointId:'bedrock-runtime.us-east-1.amazonaws.com',converse:async()=>({stopReason:'end_turn',usage:{inputTokens:40,outputTokens:20},output:{message:{role:'assistant',content:[{text:JSON.stringify(candidate)}]}}})}});
 const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,bookingInterpretation:{authority,model}});
 await runOnce(f.db,{registry,owner:'admission-controlled-model',limit:20});
 expect((await call(readPath,{requestId})).body).toMatchObject({state:'complete',outcome:{kind:'approved_link',permission:false}});
 let observations=0,waited=false;
 if(change.includes('deadline'))deadline(()=>new Date(Date.now()+300).toISOString());
 const observed:BookingInterpretationAuthorityPort={...authority,revalidate:async(context,snapshot)=>{observations++;return authority.revalidate(context,snapshot);}};
 const delayed:SessionQueryable={query:async<Row extends QueryResultRowLike>(sql:string,values?:readonly unknown[])=>{
  const result=await db.query<Row>(sql,values);
  if(sql==='COMMIT'){
   waited=true;
   if(change==='deadline')await db.query('SELECT pg_sleep(0.6)');
   else if(change==='sign-out')expect((await caller(f,owner.accessToken,await f.database.appRuntimeSession())('/auth/sign-out',{})).status).toBe(200);
   else if(change==='device-revoke')expect((await observe('/devices/revoke',{deviceId:owner.deviceId})).status).toBe(200);
  }
  if(waited&&change==='final-auth deadline'&&sql.includes('FROM sessions s'))await db.query('SELECT pg_sleep(0.6)');
  return result;
 }};
 const response=await caller(f,owner.accessToken,delayed,observed)(endpoint==='read'?readPath:requestPath,endpoint==='read'?{requestId}:command);
 expect(waited).toBe(true);expect(observations).toBe(1);
 expect(response.status).toBe(404);
 expect(JSON.stringify(response.body)).not.toContain('casey@example.test');
 expect(JSON.stringify(response.body)).not.toContain('approved_link');
 // Terminal refusal conserves the accepted reference receipt and settled work.
 expect((await f.db.query('SELECT result FROM command_receipts WHERE workspace_id=$1 AND command_id=$2',[f.alpha.workspaceId,command.commandId])).rows[0]).toEqual({result:{requestId}});
 expect((await f.db.query('SELECT count(*)::int AS n FROM crm_booking_interpretations WHERE workspace_id=$1',[f.alpha.workspaceId])).rows[0]).toEqual({n:1});
 expect((await f.db.query('SELECT state,settled_cents FROM provider_reservations WHERE subject_id=$1',[requestId])).rows[0]).toMatchObject({state:'settled',settled_cents:1});
 if(change.includes('deadline')){
  deadline(()=> '2099-01-01T00:00:00Z');
  expect((await call(requestPath,command)).body).toMatchObject({replayed:true,result:{requestId,state:'complete',outcome:{kind:'approved_link'}}});
 }
 }finally{await f.stop();}
});
