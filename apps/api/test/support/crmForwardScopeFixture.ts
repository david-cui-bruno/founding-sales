import {randomUUID,createHash} from 'node:crypto';
import {expect} from 'vitest';
import {CRM_MAIL_CAPTURE_CONSENT,CRM_OWNER_SCOPE_VERSION,businessPolicySchema,crmCapabilityReadResponseSchema} from '@fss/contracts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction,type SessionQueryable} from '@fss/domain/db/queryable.ts';
import {createCrmCapabilityVerifiers} from '@fss/domain/crm/capabilityVerifiers.ts';
import {createNativeCrmMailEvidence} from '@fss/domain/crm/nativeMailEvidence.ts';
import {businessMailCaptureHandler,createApprovedBusinessMailObserver} from '@fss/domain/mail/crmSources.ts';
import {createGmailMailCaptureProvider} from '@fss/domain/mail/crmGmailProvider.ts';
import {createGmailHttpClient} from '@fss/domain/mail/gmailClientHttp.ts';
import {claimJobs,enqueueJob} from '@fss/domain/jobs/jobStore.ts';
import {readProcessingContext,processingContextHash,NATIVE_PROCESSING_AUTHORIZATION_HASH,UNAVAILABLE_MAIL_AUTHORIZATION_HASH} from '@fss/domain/crm/processingContext.ts';
import type {SourceLookup} from '@fss/domain/crm/sourceResolver.ts';
import {flagPublishedCrmEvidence} from '@fss/domain/crm/evidenceDecisions.ts';
import {dispatch} from '../../src/server.ts';
import {CURRENT_CLIENT_VERSION,type AuthFixture} from './authFixture.ts';
import {issueSessionFor} from './sessionFixture.ts';
import {HandlerRegistry,type JobHandlerInput} from '@fss/domain/jobs/handlerRegistry.ts';
import {registerHandlers} from '../../../worker/src/bootstrap/main.ts';
import type {MailCaptureProvider} from '@fss/domain/mail/crmSources.ts';
import {businessAccountBinding} from '@fss/domain/business/acquisition.ts';
import {normalizeIdentityEndpoint} from '@fss/domain/crm/endpoints.ts';

/** F: actual ordinary owner commands. This never backdates an audit or creates
 * a consent row itself. Only fictional OAuth observations and transports exist. */
export async function activateForwardFixture(fixture:AuthFixture,mailboxId?:string){
 const workspaceId=fixture.alpha.workspaceId,ownerUserId=fixture.alpha.admin.userId;
 const db=await fixture.database.appRuntimeSession();
 const mailbox=mailboxId?(await fixture.db.query<{id:string;owner_user_id:string;provider_account_id:string;generation:number;email_address:string}>('SELECT * FROM mailboxes WHERE workspace_id=$1 AND id=$2',[workspaceId,mailboxId])).rows[0]!:(await fixture.db.query<{id:string;owner_user_id:string;provider_account_id:string;generation:number;email_address:string}>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'business@example.test','google-business','connected') RETURNING *",[workspaceId,ownerUserId])).rows[0]!;
 expect(mailbox.owner_user_id,'F fixtures require the actual admin mailbox owner').toBe(ownerUserId);
 const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
 const runtime={implementationCommit:null,imageDigest:null,side:'api' as const,schemaVersion:119,adapterAvailable:()=>true};
 const verifierSession=await fixture.database.appRuntimeSession();
 const verifiers=createCrmCapabilityVerifiers({runtime:{...runtime,side:'worker'},openSession:async()=>({session:verifierSession,close:async()=>{}})});
 const mailEvidence=createNativeCrmMailEvidence(verifiers.captureVerifier);
 const command=(value:object)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...value});
 const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:db,auth:{...fixture.deps,db},supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,crmCapabilityRuntime:runtime,crmMailEvidence:mailEvidence});
 let policy=businessPolicySchema.parse((await post('/crm/business/policy/read',{mailboxId:mailbox.id})).body);
 expect((await post('/crm/business/policy/save',command({mailboxId:mailbox.id,expectedRevision:policy.revision,expectedGeneration:mailbox.generation,expectedAccountBinding:policy.accountBinding,enabled:false,disclosure:policy.metadataReviewDisclosure}))).body).toMatchObject({status:'accepted'});
 await fixture.db.query('INSERT INTO mailbox_oauth_grant_observations(workspace_id,mailbox_id,owner_user_id,provider_account_id,generation,granted_scopes) VALUES($1,$2,$3,$4,$5,$6)',[workspaceId,mailbox.id,ownerUserId,mailbox.provider_account_id,mailbox.generation,['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send']]);
 const approval={consentAcknowledged:true,qualityTier:'acquisition',limitations:[]};
 expect((await post('/crm/business/policy/activate',command({capability:'metadata_review',mailboxId:mailbox.id,expectedRevision:policy.revision+1,approval}))).body).toMatchObject({status:'accepted'});
 policy=businessPolicySchema.parse((await post('/crm/business/policy/read',{mailboxId:mailbox.id})).body);
 const controls=(await fixture.db.query<{revision:number}>('SELECT revision FROM crm_mail_capture_controls WHERE workspace_id=$1 AND mailbox_id=$2',[workspaceId,mailbox.id])).rows[0];
 expect((await post('/crm/business/mail/controls/save',command({mailboxId:mailbox.id,expectedRevision:controls?.revision??0,expectedGeneration:mailbox.generation,expectedAccountBinding:policy.accountBinding,policyRevision:policy.revision,disclosureVersion:CRM_MAIL_CAPTURE_CONSENT.version,disclosureSha256:CRM_MAIL_CAPTURE_CONSENT.sha256}))).body).toMatchObject({status:'accepted'});
 expect((await post('/crm/business/mail/controls/activate',command({capability:'mail_capture',mailboxId:mailbox.id,expectedRevision:(controls?.revision??0)+1,approval,scopeVersion:CRM_OWNER_SCOPE_VERSION}))).body).toMatchObject({status:'accepted'});
 const capture=crmCapabilityReadResponseSchema.parse((await post('/crm/capability/read',{capability:'mail_capture',mailboxId:mailbox.id,scopeVersion:CRM_OWNER_SCOPE_VERSION})).body);
 expect(capture.ready).toBe(true);
 const context=repositoryContext(workspaceScope(workspaceId,{kind:'system',component:'worker'}),db);
 const route={endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'us.anthropic.claude-haiku-4-5-20251001-v1:0',accessGrantVersion:'fictional-current-mail',dataHandlingVersion:'fictional-only',providerKey:'aws_bedrock.fixture',fundingVerifiedUntil:'2099-01-01T00:00:00Z'};
 async function extraction(settings:Partial<typeof route>&{dailyCeilingCents?:number;monthlyCeilingCents?:number;inputTokenPriceMicros?:number|string;outputTokenPriceMicros?:number|string}={}){
  const old=(await fixture.db.query<{revision:number}>('SELECT revision FROM crm_extraction_purposes WHERE workspace_id=$1',[workspaceId])).rows[0];
  const selected={...route,...settings};
  expect((await post('/crm/processing/purpose/save',command({expectedRevision:old?.revision??0,enabled:false,endpointId:selected.endpointId,modelVersion:selected.modelVersion,accessGrantVersion:selected.accessGrantVersion,dataHandlingVersion:selected.dataHandlingVersion,dailyCeilingCents:settings.dailyCeilingCents??100,monthlyCeilingCents:settings.monthlyCeilingCents??2000,inputTokenPriceMicros:settings.inputTokenPriceMicros??1,outputTokenPriceMicros:settings.outputTokenPriceMicros??1,allowedSourceKinds:['mail'],mailCaptureOwnerApprovalId:capture.ownerApprovalId}))).body).toMatchObject({status:'accepted'});
  expect((await post('/crm/processing/purpose/activate',command({capability:'crm_extraction',expectedRevision:(old?.revision??0)+1,scopeVersion:CRM_OWNER_SCOPE_VERSION,approval:{consentAcknowledged:true,qualityTier:'provisional_owner',criticalControlsPassed:true,modelIntegrationVerified:true,reviewedEvaluationReference:'fictional-only',limitations:['representative_quality_unverified']}}))).body).toMatchObject({status:'accepted'});
  return selected;
 }
 async function original(text:string,options:{messageId?:string;threadId?:string;direction?:'incoming'|'outgoing';at?:number}={}){
  const at=options.at??Date.now(),messageId=options.messageId??`fictional_${randomUUID().replaceAll('-','')}`,threadId=options.threadId??messageId;
  const from=options.direction==='outgoing'?mailbox.email_address:'person@example.test',to=options.direction==='outgoing'?'person@example.test':mailbox.email_address,labels=options.direction==='outgoing'?['SENT']:['INBOX'];
  await withTransaction(db,()=>createApprovedBusinessMailObserver({revalidateAuthority:verifiers.revalidateMetadata,categorizeMetadata:()=>({category:'business',reason:'business_metadata',classifierVersion:'fictional'})}).observe(context,{mailboxId:mailbox.id,ownerUserId,providerAccountId:mailbox.provider_account_id,generation:mailbox.generation,metadata:{id:messageId,threadId,internalDateEpochMilliseconds:at,sizeEstimate:text.length,labelIds:labels,headers:{From:from,To:to,Subject:'Business'},attachments:[]}}));
  const gmail=createGmailHttpClient({apiBaseUrl:'https://fictional.invalid',fetch:async url=>({status:200,headers:{},body:JSON.stringify({id:messageId,threadId,internalDate:String(at),labelIds:labels,payload:{mimeType:'text/plain',headers:[{name:'From',value:from},{name:'To',value:to}],body:new URL(url).searchParams.get('format')==='full'?{data:Buffer.from(text).toString('base64url')}:{}}})})});
  const provider=createGmailMailCaptureProvider({gmail,authorizeRead:verifiers.captureVerifier.verify,resolveAccess:async()=>({mailboxId:mailbox.id,providerAccountId:mailbox.provider_account_id,generation:mailbox.generation,mailboxEmail:mailbox.email_address,access:{accessToken:'fictional-only',expiresAtEpochSeconds:Date.now()/1000+3600}})});
  const job=(await claimJobs(db,{owner:randomUUID(),kinds:['crm.mail_capture'],limit:1,leaseSeconds:120}))[0];
  expect(job,'fresh ordinary capture intent').toBeDefined();
  await businessMailCaptureHandler({provider,proofVerifier:verifiers.captureVerifier}).handle({session:db,scope:context.scope,job:job!});
  const source=(await fixture.db.query<{source_id:string;source_revision:number;content_hash:string}>('SELECT s.source_id,s.source_revision,s.content_hash FROM crm_mail_sources s JOIN crm_mail_capture_identities i ON i.workspace_id=s.workspace_id AND i.id=s.capture_identity_id WHERE s.workspace_id=$1 AND i.provider_message_id=$2',[workspaceId,messageId])).rows[0];
  expect(source,'fresh provider original was captured').toBeDefined();
  return {workspaceId,sourceId:source!.source_id,kind:'mail' as const,revision:source!.source_revision,contentHash:source!.content_hash,locator:null};
 }
 return {db,post,command,runtime,verifiers,mailEvidence,mailbox,policy,capture,context,route,extraction,original};
}

/** H: offline pre119 retained evidence only. No purpose is enabled, no owner
 * consent/audit is manufactured and no provider or processing worker is called.
 * Human review/ACL/deletion tests use the real retained read and mutation APIs. */
export async function seedHistoricalExtraction(fixture:AuthFixture,input:{source:SourceLookup;claims:readonly {kind:'need'|'objection'|'commitment';interpretation:string;status:'stated'|'inferred';locator:string;quote:string}[];modelVersion?:string;purposeRevision?:number;requestedBy?:string;session?:SessionQueryable;historicalUnknownCents?:number;historicalSettledCents?:number}){
 const source=input.source,db=input.session??fixture.db,requestedBy=input.requestedBy??fixture.alpha.admin.userId;
 const context=repositoryContext(workspaceScope(fixture.alpha.workspaceId,{kind:'user',userId:requestedBy,role:'admin'}),db),mailEvidence=createNativeCrmMailEvidence();
 const captured=await readProcessingContext(context,source,mailEvidence);expect(captured,'historical original context').not.toBeNull();
 const contextHash=processingContextHash(captured!),generationId=randomUUID();
 const purpose=(await db.query<{revision:number;model_version:string}>('SELECT revision,model_version FROM crm_extraction_purposes WHERE workspace_id=$1',[source.workspaceId])).rows[0];
 const native=source.kind==='call_transcript'?(await db.query<{owner_user_id:string;meeting_id:null;recording_id:null}>('SELECT actor_user_id AS owner_user_id,NULL::uuid AS meeting_id,NULL::uuid AS recording_id FROM call_sessions WHERE workspace_id=$1 AND id=$2',[source.workspaceId,source.sourceId])).rows[0]:source.kind==='meeting_transcript'?(await db.query<{owner_user_id:string|null;meeting_id:string;recording_id:string}>('SELECT r.crm_capture_owner_user_id AS owner_user_id,r.meeting_id,r.id AS recording_id FROM meeting_transcripts t JOIN meeting_recordings r ON r.workspace_id=t.workspace_id AND r.id=t.recording_id WHERE t.workspace_id=$1 AND t.id=$2',[source.workspaceId,source.sourceId])).rows[0]:undefined;
 const selectedOwner=source.kind==='selected_note'?(await db.query<{owner_user_id:string}>('SELECT owner_user_id FROM crm_selected_sources WHERE workspace_id=$1 AND id=$2',[source.workspaceId,source.sourceId])).rows[0]?.owner_user_id:undefined;
 const owner=(source.kind==='mail'?(await mailEvidence.resolve(context,{...source,locator:null}))?.ownerUserId:undefined)??selectedOwner??native?.owner_user_id??requestedBy;
 await db.query(`INSERT INTO crm_extraction_generations(workspace_id,id,source_id,source_kind,source_revision,source_hash,requested_by,processor_version,purpose_revision,model_version,state,context_hash,context_snapshot,authorization_hash,source_owner_user_id,original_firm_id,original_meeting_id,original_recording_id,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,'crm-extract-v1',$8,$9,'complete',$10,$11::jsonb,$12,$13,$14,$15,$16,clock_timestamp())`,[source.workspaceId,generationId,source.sourceId,source.kind,source.revision,source.contentHash,requestedBy,input.purposeRevision??purpose?.revision??0,input.modelVersion??purpose?.model_version??'historical-fixture',contextHash,JSON.stringify(captured),source.kind==='mail'?UNAVAILABLE_MAIL_AUTHORIZATION_HASH:NATIVE_PROCESSING_AUTHORIZATION_HASH,owner,native?captured!.firmIds[0]??null:null,native?.meeting_id??null,native?.recording_id??null]);
 for(const claim of input.claims)await db.query('INSERT INTO crm_extraction_claims(workspace_id,generation_id,kind,interpretation,status,locator,quote,claim_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[source.workspaceId,generationId,claim.kind,claim.interpretation,claim.status,claim.locator,claim.quote,createHash('sha256').update(JSON.stringify({source,context:captured,...claim})).digest('hex')]);
 await flagPublishedCrmEvidence(context,source,contextHash,input.claims);
 if(input.historicalUnknownCents!==undefined||input.historicalSettledCents!==undefined){
  // Offline pre119 ledger, not a dispatch or consent. The real retained APIs
  // must still conserve this already-incurred money after native deletion.
  const cents=input.historicalUnknownCents??input.historicalSettledCents!,unknown=input.historicalUnknownCents!==undefined,reservationId=randomUUID();
  await enqueueJob(db,{workspaceId:source.workspaceId,kind:'crm.extract',idempotencyKey:`historical-ledger:${generationId}`,payload:{generationId}});
  await db.query("UPDATE jobs SET state='done',completed_at=clock_timestamp() WHERE workspace_id=$1 AND idempotency_key=$2",[source.workspaceId,`historical-ledger:${generationId}`]);
  await db.query("INSERT INTO provider_reservations(workspace_id,id,provider_key,subject_kind,subject_id,attempt,business_date,business_time_zone,cents,model_name,max_input_tokens,max_output_tokens,state,settled_cents,settled_at) VALUES($1,$2,'historical.crm_extraction','crm_extraction',$3,1,current_date,'America/New_York',$4,'historical-model',2000,4096,'estimated',$4,now())",[source.workspaceId,reservationId,generationId,cents]);
  await db.query("INSERT INTO crm_extraction_financial_receipts(workspace_id,generation_id,reservation_id,job_id,fencing_token,dispatch_state,endpoint_id,model_version,access_grant_version,data_handling_version,purpose_revision,input_price_micros,output_price_micros) SELECT $1,$2,$3,id,1,'unknown_acceptance','historical-adapter','historical-model','historical-grant','historical-policy',$4,2,8 FROM jobs WHERE workspace_id=$1 AND idempotency_key=$5",[source.workspaceId,generationId,reservationId,input.purposeRevision??purpose?.revision??0,`historical-ledger:${generationId}`]);
  if(!unknown)await db.query("UPDATE crm_extraction_financial_receipts SET dispatch_state='settled' WHERE workspace_id=$1 AND generation_id=$2",[source.workspaceId,generationId]);
  else await db.query("UPDATE crm_extraction_generations SET state='unknown_acceptance',reason='provider_acceptance_unknown' WHERE workspace_id=$1 AND id=$2",[source.workspaceId,generationId]);
 }
 return generationId;
}

/** H only: load explicitly offline, pre119 retained originals. The legacy job
 * identifies fixture rows and supplies required provenance foreign keys. This
 * is NOT the capture handler, an approval, a verifier, or a provider adapter.
 * Every non-capture handler below remains the real registered implementation. */
export function historicalMailFixtureRegistry(composition:Omit<Parameters<typeof registerHandlers>[1],'crmMailCapture'>&{retainedMailFixture?:{original:MailCaptureProvider}}){
 const registry=new HandlerRegistry(),{retainedMailFixture,...ordinary}=composition,retainedMailOriginal=retainedMailFixture?.original;
 for(const handler of registerHandlers(new HandlerRegistry(),ordinary).all())if(handler.kind!=='crm.mail_capture'||!retainedMailOriginal)registry.register(handler);
 if(retainedMailOriginal)registry.register({kind:'crm.mail_capture',protection:'outbound_fence',maxAttempts:6,leaseSeconds:120,async handle(input){return seedRetainedMailOriginal(input,retainedMailOriginal);}});
 return registry;
}
async function seedRetainedMailOriginal(input:JobHandlerInput,original:MailCaptureProvider){
 const db=input.session,workspaceId=input.scope.workspaceId,payload=input.job.payload as {mailboxId:string;providerMessageId:string;providerAccountId:string;generation:number;conversationId:string;controlsRevision:number;policyRevision:number;decisionRevision:number};
 const mailbox=(await db.query<{id:string;owner_user_id:string;email_address:string;provider_account_id:string;generation:number;status:string}>('SELECT * FROM mailboxes WHERE workspace_id=$1 AND id=$2',[workspaceId,payload.mailboxId])).rows[0]!;
 const binding=businessAccountBinding(workspaceId,mailbox)!;
 const old=(await db.query<{source_id:string;source_revision:number;content_hash:string}>('SELECT s.source_id,s.source_revision,s.content_hash FROM crm_mail_sources s JOIN crm_mail_capture_identities i ON i.workspace_id=s.workspace_id AND i.id=s.capture_identity_id WHERE s.workspace_id=$1 AND i.mailbox_id=$2 AND i.provider_message_id=$3',[workspaceId,mailbox.id,payload.providerMessageId])).rows[0];
 if(old)return {done:true,progress:{outcome:'already_captured',sourceId:old.source_id,sourceRevision:old.source_revision,contentHash:old.content_hash}};
 const m=await original.read({workspaceId,mailboxId:mailbox.id,providerMessageId:payload.providerMessageId,providerAccountId:mailbox.provider_account_id,generation:mailbox.generation});
 const outgoing=m.labels.includes('SENT')&&!m.labels.includes('DRAFT'),hash=createHash('sha256').update(m.body??'').digest('hex');
 let sourceId=(await db.query<{id:string}>('SELECT id FROM mail_messages WHERE workspace_id=$1 AND mailbox_id=$2 AND provider_message_id=$3',[workspaceId,mailbox.id,m.messageId])).rows[0]?.id;
 if(!sourceId)sourceId=(await db.query<{id:string}>('INSERT INTO mail_messages(workspace_id,mailbox_id,provider_message_id,provider_thread_id,direction,internal_date,header_from,header_to,header_cc,subject,label_ids,business_capture_authorized,metadata_only) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12) RETURNING id',[workspaceId,mailbox.id,m.messageId,m.threadId,outgoing?'outgoing':'incoming',m.providerAt,m.from.toLowerCase(),m.to.map(x=>x.toLowerCase()),m.cc.map(x=>x.toLowerCase()),m.subject,m.labels,m.body===null])).rows[0]!.id;
 if(m.body!==null)await db.query('INSERT INTO mail_message_bodies(workspace_id,mail_message_id,body_text,truncated) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[workspaceId,sourceId,m.body,m.completeness!=='complete']);
 await db.query('UPDATE mail_messages SET business_capture_authorized=true,metadata_only=$3,attachment_references=$4::jsonb WHERE workspace_id=$1 AND id=$2',[workspaceId,sourceId,m.body===null,JSON.stringify(m.attachments??[])]);
 const matches=(await db.query<{id:string;firm_id:string;opportunity_id:string;contact_id:string|null;ambiguous:boolean;selected:boolean|null;resolved_at:Date|null;created_at:Date;match_rule:string}>('SELECT id,firm_id,opportunity_id,contact_id,ambiguous,selected,resolved_at,created_at,match_rule FROM mail_message_matches WHERE workspace_id=$1 AND mail_message_id=$2 ORDER BY id',[workspaceId,sourceId])).rows;
 const snapshot=matches.map(row=>({matchId:row.id,firmId:row.firm_id,opportunityId:row.opportunity_id,contactId:row.contact_id,ambiguous:row.ambiguous,snapshotHash:createHash('sha256').update(JSON.stringify(row)).digest('hex')}));
 const identity=(await db.query<{id:string}>("INSERT INTO crm_mail_capture_identities(workspace_id,mailbox_id,account_binding,provider_message_id,context_snapshot,source_id,lease_fencing_token,job_id,state) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::bigint,$8,'copied') RETURNING id",[workspaceId,mailbox.id,binding,m.messageId,JSON.stringify(snapshot),sourceId,input.job.fencingToken,input.job.id])).rows[0]!.id;
 const sent=m.origin==='sent'&&outgoing&&m.from===mailbox.email_address&&m.to.length>0&&m.completeness==='complete'&&m.representation==='plain_text'&&m.ranges.some(r=>r.kind==='authored');
 await db.query(`INSERT INTO crm_mail_sources(workspace_id,source_id,capture_identity_id,source_revision,content_hash,owner_user_id,mailbox_id,provider_account_id,account_binding,acquired_generation,controls_revision,policy_revision,conversation_id,decision_revision,disclosure_version,disclosure_sha256,verification_receipts,parser_version,representation,completeness,passage_ranges,participants,raw_sender_date,provider_at,sent_proof,provider_origin,representation_diagnostics) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'offline-pre119',repeat('b',64),'{}'::jsonb,$14,$15,$16,$17::jsonb,$18::jsonb,$19,$20,$21,$22,$23::jsonb)`,[workspaceId,sourceId,identity,hash,mailbox.owner_user_id,mailbox.id,mailbox.provider_account_id,binding,mailbox.generation,payload.controlsRevision,payload.policyRevision,payload.conversationId,payload.decisionRevision,m.parserVersion,m.representation,m.completeness,JSON.stringify(m.ranges),JSON.stringify([m.from,...m.to,...m.cc].map(x=>normalizeIdentityEndpoint('email',x))),m.rawSenderDate,m.providerAt,sent,m.origin??'unknown',JSON.stringify(m.representationDiagnostics??[])]);
 for(const match of snapshot)await db.query("INSERT INTO crm_mail_source_contexts(workspace_id,source_id,source_revision,firm_id,opportunity_id,context_kind,operational_match_id,operational_match_hash,review) VALUES($1,$2,1,$3,$4,'acquired',$5,$6,$7)",[workspaceId,sourceId,match.firmId,match.opportunityId,match.matchId,match.snapshotHash,match.ambiguous?'review_required':'current']);
 if(m.fromDisplayName&&!outgoing){const person=(await db.query<{id:string}>('INSERT INTO crm_people(workspace_id,owner_user_id,full_name) VALUES($1,$2,$3) RETURNING id',[workspaceId,mailbox.owner_user_id,m.fromDisplayName])).rows[0]!.id;await db.query("INSERT INTO crm_mail_source_contexts(workspace_id,source_id,source_revision,person_id,context_kind,review,identity_status,correspondent_endpoint_hash,observed_full_name_hash) VALUES($1,$2,1,$3,'acquired','review_required','observed_label',$4,$5)",[workspaceId,sourceId,person,createHash('sha256').update(m.from.toLowerCase()).digest('hex'),createHash('sha256').update(m.fromDisplayName).digest('hex')]);}
 await db.query("INSERT INTO crm_mail_source_intents(workspace_id,source_kind,source_id,source_revision,content_hash) VALUES($1,'mail',$2,1,$3)",[workspaceId,sourceId,hash]);
 return {done:true,progress:{outcome:'captured',sourceId,sourceRevision:1,contentHash:hash}};
}
