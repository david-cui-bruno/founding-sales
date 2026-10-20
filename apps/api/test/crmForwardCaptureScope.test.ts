import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {afterEach,expect,it} from 'vitest';
import {businessPolicySchema,CRM_MAIL_CAPTURE_CONSENT,CRM_OWNER_SCOPE_VERSION,crmCapabilityReadResponseSchema} from '@fss/contracts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {dispatch} from '../src/server.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {claimJobs} from '@fss/domain/jobs/jobStore.ts';
import {createApprovedBusinessMailObserver} from '@fss/domain/mail/crmSources.ts';
import {createGmailMailCaptureProvider} from '@fss/domain/mail/crmGmailProvider.ts';
import {createGmailHttpClient} from '@fss/domain/mail/gmailClientHttp.ts';
import {createCrmCapabilityVerifiers} from '@fss/domain/crm/capabilityVerifiers.ts';
import {forwardCaptureScopeForApproval,isForwardCaptureDateAllowed} from '@fss/domain/mail/crmForwardCaptureScope.ts';
import {processMessageIds} from '@fss/domain/mail/pipeline.ts';
import {readMailbox} from '@fss/domain/mail/mailboxes.ts';
import {localEnvelopeCipher} from '@fss/domain/mail/envelope.ts';
import {recordingSuppressionJournal} from '@fss/domain/suppression/journal.ts';
import {isSuppressed} from '@fss/domain/suppression/effective.ts';
import {listApplicableHolds} from '@fss/domain/policy/holds.ts';
import {promoteReply} from '@fss/domain/today/promotions.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {seedFirm,seedContact} from './support/crmSeed.ts';

let fixture:AuthFixture|undefined;
afterEach(async()=>{await fixture?.stop();fixture=undefined;});
async function setup(){
 const f=await createAuthFixture();fixture=f;
 const db=await f.database.appRuntimeSession(),workspaceId=f.alpha.workspaceId,ownerUserId=f.alpha.admin.userId;
 const token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
 const runtime={implementationCommit:null,imageDigest:null,side:'api' as const,schemaVersion:119,adapterAvailable:()=>true};
 const command=<T extends Record<string,unknown>>(body:T)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...body});
 const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:db,auth:{...f.deps,db},supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,crmCapabilityRuntime:runtime});
 const mailbox=(await f.db.query<{id:string}>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'owner@example.test','google-owner','connected') RETURNING id",[workspaceId,ownerUserId])).rows[0]!;
 const policy=businessPolicySchema.parse((await post('/crm/business/policy/read',{mailboxId:mailbox.id})).body);
 await post('/crm/business/policy/save',command({mailboxId:mailbox.id,expectedRevision:0,expectedGeneration:policy.generation,expectedAccountBinding:policy.accountBinding,enabled:false,disclosure:policy.metadataReviewDisclosure}));
 await f.db.query("INSERT INTO mailbox_oauth_grant_observations(workspace_id,mailbox_id,owner_user_id,provider_account_id,generation,granted_scopes) VALUES($1,$2,$3,'google-owner',$4,$5)",[workspaceId,mailbox.id,ownerUserId,policy.generation,['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send']]);
 const acquisition={consentAcknowledged:true,qualityTier:'acquisition',limitations:[]};
 expect((await post('/crm/business/policy/activate',command({capability:'metadata_review',mailboxId:mailbox.id,expectedRevision:1,approval:acquisition}))).body).toMatchObject({status:'accepted'});
 expect((await post('/crm/business/mail/controls/save',command({mailboxId:mailbox.id,expectedRevision:0,expectedGeneration:policy.generation,expectedAccountBinding:policy.accountBinding,policyRevision:2,disclosureVersion:CRM_MAIL_CAPTURE_CONSENT.version,disclosureSha256:CRM_MAIL_CAPTURE_CONSENT.sha256}))).body).toMatchObject({status:'accepted'});
 const read=async()=>crmCapabilityReadResponseSchema.parse((await post('/crm/capability/read',{capability:'mail_capture',mailboxId:mailbox.id,scopeVersion:CRM_OWNER_SCOPE_VERSION})).body);
 const activation=command({capability:'mail_capture',mailboxId:mailbox.id,expectedRevision:1,approval:acquisition,scopeVersion:CRM_OWNER_SCOPE_VERSION});
 const activate=()=>post('/crm/business/mail/controls/activate',activation);
 const context=repositoryContext(workspaceScope(workspaceId,{kind:'system',component:'worker'}),db);
 const verifiers=createCrmCapabilityVerifiers({runtime:{...runtime,side:'worker'},openSession:async()=>({session:await f.database.appRuntimeSession(),close:async()=>{}})});
 const observe=async(messageId:string,at:number,sent=false)=>withTransaction(db,()=>createApprovedBusinessMailObserver({revalidateAuthority:verifiers.revalidateMetadata,categorizeMetadata:()=>({category:'business',reason:'business_metadata',classifierVersion:'test'})}).observe(context,{mailboxId:mailbox.id,ownerUserId,providerAccountId:'google-owner',generation:policy.generation!,metadata:{id:messageId,threadId:'business_thread',internalDateEpochMilliseconds:at,sizeEstimate:100,labelIds:[sent?'SENT':'INBOX'],headers:{From:sent?'owner@example.test':'person@example.test',To:sent?'person@example.test':'owner@example.test',Subject:'Business proposal'},attachments:[]}}));
 function controlledGmail(messageId:string,at:number,sent:boolean,body:string,onRead:(full:boolean)=>Promise<void>){
  return createGmailHttpClient({apiBaseUrl:'https://controlled.invalid',fetch:async url=>{
   const request=new URL(url);
   // No history, listing, watch, token exchange, draft creation or send is part of this acceptance.
   expect(request.pathname).toBe(`/gmail/v1/users/me/messages/${messageId}`);
   const format=request.searchParams.get('format');expect(['metadata','full']).toContain(format);
   const full=format==='full';await onRead(full);
   return {status:200,headers:{},body:JSON.stringify({id:messageId,threadId:'business_thread',internalDate:String(at),labelIds:[sent?'SENT':'INBOX'],payload:{mimeType:'text/plain',headers:[{name:'From',value:sent?'owner@example.test':'person@example.test'},{name:'To',value:sent?'person@example.test':'owner@example.test'},{name:'Subject',value:'Business proposal'},{name:'Message-ID',value:`<${messageId}@example.test>`},{name:'Date',value:new Date(at).toUTCString()}],body:full?{data:Buffer.from(body).toString('base64url')}:{}}})};
  }});
 }
 const journal=recordingSuppressionJournal();
 async function ingest(messageId:string,at:number,sent:boolean,body:string){
  const gmail=controlledGmail(messageId,at,sent,body,async()=>{});
  const current=await readMailbox(context,mailbox.id);if(!current)throw new Error('missing mailbox');
  const report=await withTransaction(db,()=>processMessageIds(context,{
   gmail,oauth:{clientId:'controlled.apps.example.test',clientSecret:randomBytes(24).toString('base64url'),redirectUri:'http://localhost/callback',authorizationEndpoint:'https://controlled.invalid/auth',tokenEndpoint:'https://controlled.invalid/token',revocationEndpoint:'https://controlled.invalid/revoke',apiBaseUrl:'https://controlled.invalid'},
   cipher:localEnvelopeCipher('controlled-envelope'),journal,replyPromoter:{promoteReply:async(c,p)=>{await promoteReply(c,p);}},
   businessMailObserver:createApprovedBusinessMailObserver({revalidateAuthority:verifiers.revalidateMetadata,categorizeMetadata:()=>({category:'business',reason:'business_metadata',classifierVersion:'test'})}),
  },{mailbox:current,access:{accessToken:randomBytes(24).toString('base64url'),expiresAtEpochSeconds:Date.now()/1000+3600},messageIds:[messageId]}));
  return report;
 }
 async function capture(messageId:string,at:number,sent=false,afterBody?:()=>Promise<void>,body='Controlled current business original.'){
  let bodyReads=0,metadataReads=0;
  const gmail=controlledGmail(messageId,at,sent,body,async full=>{if(full){bodyReads++;await afterBody?.();}else metadataReads++;});
  const provider=createGmailMailCaptureProvider({gmail,authorizeRead:verifiers.captureVerifier.verify,resolveAccess:async()=>({mailboxId:mailbox.id,providerAccountId:'google-owner',generation:policy.generation!,mailboxEmail:'owner@example.test',access:{accessToken:'controlled-fixture-only',expiresAtEpochSeconds:Date.now()/1000+3600}})});
  const job=(await claimJobs(db,{owner:randomUUID(),kinds:['crm.mail_capture'],limit:1,leaseSeconds:120}))[0];
  expect(job).toBeDefined();
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailCapture:{provider,proofVerifier:verifiers.captureVerifier}});
  const handler=registry.get('crm.mail_capture');if(!handler)throw new Error('capture handler not registered');
  const result=await handler.handle({session:db,scope:context.scope,job:job!});
  return {result,bodyReads,metadataReads};
 }
 return {f,db,post,command,mailbox,policy,read,activation,activate,acquisition,context,observe,ingest,capture};
}

it('requires new scope negotiation, creates a DB-derived immutable epoch and replays without moving it',async()=>{
 const h=await setup();
 const {scopeVersion:_version,...legacy}=h.activation;
 expect((await h.post('/crm/business/mail/controls/activate',{...legacy,commandId:randomUUID()})).body).toMatchObject({status:'refused',reason:'capability_scope_review_required'});
 expect((await h.read()).enabled).toBe(false);
 expect((await h.activate()).body).toMatchObject({status:'accepted',result:{enabled:true,revision:2}});
 const first=await h.read();expect(first.ready).toBe(true);
 expect(first.configuration).toMatchObject({forwardScope:{mode:'forward_only',enabledAt:expect.any(String)}});
 const audit=(await h.f.db.query<{at:string;scope_configuration:unknown}>(`SELECT to_char(approved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,scope_configuration FROM crm_capability_owner_approvals WHERE id=$1`,[first.ownerApprovalId])).rows[0]!;
 expect(first.configuration?.capability==='mail_capture'&&first.configuration.forwardScope).toEqual(forwardCaptureScopeForApproval(audit.at));
 expect((await h.activate()).body).toMatchObject({status:'accepted',replayed:true});
 expect((await h.read()).configuration).toEqual(first.configuration);
 await expect(h.f.db.query('UPDATE crm_capability_owner_approvals SET scope_configuration=NULL WHERE id=$1',[first.ownerApprovalId])).rejects.toThrow('immutable');
});

it('projects exact legacy outer and nested read fields while scoped readers see the cutoff',async()=>{
 const h=await setup();await h.activate();
 const modern=await h.read();
 const legacy=crmCapabilityReadResponseSchema.parse((await h.post('/crm/capability/read',{capability:'mail_capture',mailboxId:h.mailbox.id})).body);
 expect(legacy).not.toHaveProperty('scopeVersion');expect(legacy.configuration).not.toHaveProperty('forwardScope');
 const {scopeVersion:_scope,configuration:_configuration,...outer}=modern;
 expect(legacy).toMatchObject(outer);
 expect(Object.keys(legacy.configuration??{})).toEqual(['workspaceId','ownerUserId','revision','mailboxId','providerAccountId','generation','accountBinding','capability','policyRevision','disclosureVersion','disclosureSha256','grantReceipt','providerPolicyReceipt','evaluationReceipt','releaseReceipt','captureVersion']);
});

it('does not create older CRM metadata or jobs, and captures new incoming and Sent originals through controlled transport/parser/PG',async()=>{
 const h=await setup();await h.activate();
 const view=await h.read();if(view.configuration?.capability!=='mail_capture'||!view.configuration.forwardScope)throw new Error('missing epoch');
 const cutoff=Date.parse(view.configuration.forwardScope.enabledAt);
 expect(await h.observe('old_original',cutoff-1)).toMatchObject({ok:false});
 expect((await h.f.db.query('SELECT 1 FROM crm_business_conversations')).rows).toHaveLength(0);
 expect((await h.f.db.query("SELECT 1 FROM jobs WHERE kind='crm.mail_capture'")).rows).toHaveLength(0);
 for(const sent of [false,true]){
  const id=sent?'new_sent':'new_incoming',at=cutoff+10;
  expect(await h.observe(id,at,sent)).toMatchObject({ok:true});
  const result=await h.capture(id,at,sent);expect(result.bodyReads).toBe(1);expect(result.result).toMatchObject({done:true,progress:{outcome:'captured'}});
 }
 const sources=(await h.f.db.query<{provider_origin:string;sent_proof:boolean}>('SELECT provider_origin,sent_proof FROM crm_mail_sources ORDER BY provider_origin')).rows;
 // Real Sent origin is retained without inventing authenticated authorship ranges.
 expect(sources).toEqual([{provider_origin:'received',sent_proof:false},{provider_origin:'sent',sent_proof:false}]);
 const bodyFree=await h.post('/crm/business/mail/list',{mailboxId:h.mailbox.id,limit:20});
 expect(bodyFree.body).toMatchObject({sources:[{},{}]});expect(JSON.stringify(bodyFree.body)).not.toContain('Controlled current business original');
});

it('arrives from the operational matching pipeline in private CRM reads while reply/refusal stops survive Sent capture and replay',async()=>{
 const h=await setup();await h.activate();
 const view=await h.read();if(view.configuration?.capability!=='mail_capture'||!view.configuration.forwardScope)throw new Error('missing epoch');
 const at=Date.parse(view.configuration.forwardScope.enabledAt)+10,workspaceId=h.f.alpha.workspaceId;
 const firmId=await seedFirm(h.f,{name:'Controlled business firm',assignedUserId:h.f.alpha.admin.userId});
 const contactId=await seedContact(h.f,{firmId,fullName:'Controlled business correspondent'});
 expect((await h.post('/contacts/routes/add',h.command({firmId,contactId,routeKind:'email',value:'person@example.test',source:'salesperson',technicalValidation:'passed',associationConfidence:0.95}))).body).toMatchObject({status:'accepted'});
 const opportunityId=(await h.f.db.query<{id:string}>(`INSERT INTO opportunities(workspace_id,firm_id,stage_id,control_mode_changed_at)
  VALUES($1,$2,(SELECT id FROM pipeline_stages WHERE workspace_id=$1 ORDER BY position LIMIT 1),now()) RETURNING id`,[workspaceId,firmId])).rows[0]!.id;
 const subject={firmId,opportunityId,ownerUserId:h.f.alpha.admin.userId};
 const originals=[
  {id:'arriving_reply',sent:false,body:'Can we talk about the business proposal on Tuesday?',rule:'participant'},
  {id:'arriving_sent',sent:true,body:'Here are the business proposal details we discussed.',rule:'thread'},
  {id:'arriving_refusal',sent:false,body:'Please remove me from your list. Do not contact me again.',rule:'thread'},
 ];
 for(const [index,original] of originals.entries()){
  const providerAt=at+index;
  const report=await h.ingest(original.id,providerAt,original.sent,original.body);
  expect(report).toMatchObject({messagesRecorded:1,matched:1,ambiguous:0,processedMessages:1,readFailure:null});
  const matches=(await h.f.db.query<{firm_id:string;opportunity_id:string;contact_id:string;match_rule:string}>(`SELECT x.firm_id,x.opportunity_id,x.contact_id,x.match_rule FROM mail_message_matches x
   JOIN mail_messages m ON m.workspace_id=x.workspace_id AND m.id=x.mail_message_id WHERE m.workspace_id=$1 AND m.mailbox_id=$2 AND m.provider_message_id=$3`,[workspaceId,h.mailbox.id,original.id])).rows;
  expect(matches).toEqual([{firm_id:firmId,opportunity_id:opportunityId,contact_id:contactId,match_rule:original.rule}]);
  const captured=await h.capture(original.id,providerAt,original.sent,undefined,original.body);
  expect(captured).toMatchObject({bodyReads:1,metadataReads:1,result:{done:true,progress:{outcome:'captured',sourceRevision:1}}});
  const sourceId=captured.result?.progress['sourceId'];expect(typeof sourceId).toBe('string');
  expect((await h.post('/crm/business/mail/read',{sourceId,sourceRevision:1,contentHash:createHash('sha256').update(original.body).digest('hex')})).body).toMatchObject({
   state:'available',source:{sourceId,sourceRevision:1,passage:original.body,mailboxId:h.mailbox.id,ownerUserId:h.f.alpha.admin.userId,acquiredGeneration:h.policy.generation,sentProof:false},
  });
  // Capturing an already-observed manual Sent original is not a release of a reply hold.
  for(const actionKind of ['email_send','call_task','enrollment_advance'] as const){
   expect((await listApplicableHolds(h.context,{...subject,actionKind})).map(hold=>hold.reasonCode)).toContain('uncertain_reply');
  }
 }
 expect((await h.f.db.query("SELECT 1 FROM today_items WHERE workspace_id=$1 AND firm_id=$2 AND kind='reply'",[workspaceId,firmId])).rows).toHaveLength(2);
 for(const key of [{scope:'handle' as const,canonicalKey:'person@example.test'},{scope:'firm' as const,canonicalKey:firmId}]){
  expect(await isSuppressed(h.context,key)).toMatchObject({source:'prospect_opt_out',channel:'email'});
 }
 const counts=async()=>({
  sources:(await h.f.db.query('SELECT 1 FROM crm_mail_sources WHERE workspace_id=$1',[workspaceId])).rowCount,
  jobs:(await h.f.db.query("SELECT 1 FROM jobs WHERE workspace_id=$1 AND kind='crm.mail_capture'",[workspaceId])).rowCount,
  effects:(await h.f.db.query('SELECT 1 FROM mail_message_effects WHERE workspace_id=$1',[workspaceId])).rowCount,
  suppressions:(await h.f.db.query('SELECT 1 FROM suppression_events WHERE workspace_id=$1',[workspaceId])).rowCount,
  replies:(await h.f.db.query("SELECT 1 FROM today_items WHERE workspace_id=$1 AND firm_id=$2 AND kind='reply'",[workspaceId,firmId])).rowCount,
 });
 const before=await counts();expect(before.sources).toBe(3);expect(before.jobs).toBe(3);
 for(const [index,original] of originals.entries()){
  expect(await h.ingest(original.id,at+index,original.sent,original.body)).toMatchObject({messagesRecorded:0,processedMessages:1,readFailure:null,suppressionsRecorded:0,directSendsRecorded:0});
 }
 expect(await counts()).toEqual(before);
 const listed=await h.post('/crm/business/mail/list',{mailboxId:h.mailbox.id,limit:20});
 expect(listed.body).toMatchObject({sources:[{},{},{}]});
 for(const original of originals)expect(JSON.stringify(listed.body)).not.toContain(original.body);
 expect((await h.f.db.query('SELECT 1 FROM sequence_enrollments WHERE workspace_id=$1',[workspaceId])).rows).toHaveLength(0);
 expect((await h.f.db.query('SELECT 1 FROM outbound_messages WHERE workspace_id=$1',[workspaceId])).rows).toHaveLength(0);
});

it('fresh metadata cannot substitute an older original between queue and body fetch',async()=>{
 const h=await setup();await h.activate();const v=await h.read();if(v.configuration?.capability!=='mail_capture'||!v.configuration.forwardScope)throw new Error('missing epoch');
 const cutoff=Date.parse(v.configuration.forwardScope.enabledAt);await h.observe('changed_date',cutoff+10);
 await expect(h.capture('changed_date',cutoff-1)).rejects.toThrow('forward scope unavailable');
 expect((await h.f.db.query('SELECT 1 FROM crm_mail_sources')).rows).toHaveLength(0);
});

it('Disable after a provider wait refuses publication and a new activation has a fresh epoch',async()=>{
 const h=await setup();await h.activate();const first=await h.read();if(first.configuration?.capability!=='mail_capture'||!first.configuration.forwardScope)throw new Error('missing epoch');
 const at=Date.parse(first.configuration.forwardScope.enabledAt)+10;await h.observe('disabled_during_read',at);
 const result=await h.capture('disabled_during_read',at,false,async()=>{await h.f.db.query('UPDATE crm_mail_capture_controls SET enabled=false,revision=revision+1,owner_approval_id=NULL WHERE mailbox_id=$1',[h.mailbox.id]);});
 expect(result.bodyReads).toBe(1);expect(result.result).toMatchObject({done:true,progress:{outcome:'verification_unavailable'}});
 expect((await h.f.db.query('SELECT 1 FROM crm_mail_sources')).rows).toHaveLength(0);
 expect((await h.post('/crm/business/mail/controls/activate',h.command({capability:'mail_capture',mailboxId:h.mailbox.id,expectedRevision:3,approval:h.acquisition,scopeVersion:CRM_OWNER_SCOPE_VERSION}))).body).toMatchObject({status:'accepted'});
 const next=await h.read();expect(next.ownerApprovalId).not.toBe(first.ownerApprovalId);
 expect(next.configuration?.capability==='mail_capture'&&next.configuration.forwardScope?.enabledAt).not.toBe(first.configuration.forwardScope.enabledAt);
 expect(isForwardCaptureDateAllowed(first.configuration.forwardScope,at)).toBe(true);
});
