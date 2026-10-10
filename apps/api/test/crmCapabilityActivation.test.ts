import {z} from 'zod';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {createCrmCapabilityVerifiers} from '@fss/domain/crm/capabilityVerifiers.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {crmProcessingResultSchema,personPageSchema,businessPolicySchema,crmCapabilityReadResponseSchema,type CrmCapabilityAuthorityReceipt,type CrmCapabilityConfiguration} from '@fss/contracts';
import {CRM_MAIL_CAPTURE_DISCLOSURE,crmCapabilityConfigurationFingerprint,provisionCrmCapabilityAuthority,revokeCrmCapabilityAuthority,type CrmCapabilityRuntime} from '@fss/domain/crm/capabilityAuthority.ts';
import {storeFixtureCiGateRecord,FIXTURE_CI_COMMIT,FIXTURE_API_DIGEST,FIXTURE_WORKER_DIGEST} from '@fss/domain/test/release/support/releaseRecords.ts';
import type {SessionQueryable} from '@fss/domain/db/queryable.ts';
import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';

const paths = ['/crm/business/policy/activate','/crm/business/policy/disable','/crm/business/mail/controls/save','/crm/business/mail/controls/activate','/crm/business/mail/controls/disable','/crm/processing/purpose/activate','/crm/processing/purpose/disable','/ask/purpose/read','/ask/purpose/save','/ask/purpose/activate','/ask/purpose/disable','/crm/capability/read'];
describe('explicit independently authorized CRM capability commands',()=>{
 let fixture:AuthFixture;let token:string;let runtimeDb:SessionQueryable;let releaseReference:string;
 const runtime:CrmCapabilityRuntime={implementationCommit:FIXTURE_CI_COMMIT,imageDigest:FIXTURE_API_DIGEST,side:'api',schemaVersion:88,adapterAvailable:()=>true};
 const post=(path:string,body:unknown,bearer:string|undefined=token,useRuntime=true)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:bearer?{authorization:`Bearer ${bearer}`} : {}},{session:runtimeDb,auth:{...fixture.deps,db:runtimeDb},supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,...useRuntime?{crmCapabilityRuntime:runtime}:{}});
 const command=(payload:Record<string,unknown>)=>({...payload,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
 beforeAll(async()=>{fixture=await createAuthFixture();token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;runtimeDb=await fixture.database.appRuntimeSession();releaseReference=await storeFixtureCiGateRecord(fixture.db,'98801');});
 afterAll(async()=>fixture.stop());
 function receiptFor(configuration:CrmCapabilityConfiguration,kind:'actual_representative'|'actual_acceptance'|'controlled_fixture'='actual_representative',oauthGrantObservationId:string|null=null){
  const receipt:CrmCapabilityAuthorityReceipt={id:randomUUID(),configuration,configurationFingerprint:crmCapabilityConfigurationFingerprint(configuration),reviewedBy:fixture.alpha.admin.userId,reviewReference:'synthetic independently reviewed fixture',verifiedAt:new Date(Date.now()-1000).toISOString(),validUntil:new Date(Date.now()+3600000).toISOString(),proof:{evaluationKind:kind,evaluationFingerprint:configuration.capability==='ask_answer'?configuration.evaluationFingerprint:'a'.repeat(64),evaluationConfigurationFingerprint:crmCapabilityConfigurationFingerprint(configuration),evaluationReference:configuration.capability==='mail_capture'?configuration.evaluationReceipt:'synthetic evaluation reference',accessGrantReference:'synthetic granted access',dataHandlingReference:'synthetic no retention',providerAcceptanceReference:'synthetic acceptance',deletionAcceptanceReference:'synthetic deletion',fundingReference:'synthetic funding',oauthGrantObservationId,release:{reference:releaseReference,implementationCommit:FIXTURE_CI_COMMIT,apiImageDigest:FIXTURE_API_DIGEST,workerImageDigest:FIXTURE_WORKER_DIGEST,schemaVersion:88,nativeAcceptanceReference:'synthetic native acceptance'}}};
  return receipt;
 }
 async function provision(configuration:CrmCapabilityConfiguration,kind:'actual_representative'|'actual_acceptance'|'controlled_fixture'='actual_representative',oauthGrantObservationId:string|null=null){
  const receipt=receiptFor(configuration,kind,oauthGrantObservationId);
  await fixture.db.query('SET ROLE migration');
  try{expect(await provisionCrmCapabilityAuthority(fixture.db,receipt)).toMatchObject({ok:true});}finally{await fixture.db.query('RESET ROLE');}
  return receipt.id;
 }

 it('requires an authenticated session before reading or mutating any capability',async()=>{
  for(const path of paths)expect((await post(path,command({}),'' )).status,path).toBe(401);
 });
 it('activates only the resulting extraction revision and remains ready until explicit disable',async()=>{
  const before=(await post('/outreach/control/v2',{})).body;
  const saved=await post('/crm/processing/purpose/save',command({expectedRevision:0,enabled:false,endpointId:'synthetic-current-route',modelVersion:'synthetic-model-v1',accessGrantVersion:'independent-grant-v1',dataHandlingVersion:'independent-handling-v1',dailyCeilingCents:10,monthlyCeilingCents:100,inputTokenPriceMicros:1,outputTokenPriceMicros:1}));
  expect(saved.body).toMatchObject({status:'accepted',result:{revision:1,enabled:false}});
  const read=crmCapabilityReadResponseSchema.parse((await post('/crm/capability/read',{capability:'crm_extraction'})).body);
  expect(read).toMatchObject({configured:true,revision:1,enabled:false,ready:false,proposedRevision:2});
  if(!read.configuration)throw new Error('disabled extraction configuration missing');
  const stale=await provision(read.configuration);
  expect((await post('/crm/processing/purpose/activate',command({capability:'crm_extraction',expectedRevision:1,authorityReceiptId:stale}))).body).toMatchObject({status:'refused',reason:'authority_unavailable'});
  const authorityReceiptId=await provision({...read.configuration,revision:2});
  const activate=command({capability:'crm_extraction',expectedRevision:1,authorityReceiptId});
  expect((await post('/crm/processing/purpose/activate',activate)).body).toMatchObject({status:'accepted',replayed:false,result:{revision:2,enabled:true,authorityReceiptId}});
  expect((await post('/crm/processing/purpose/activate',activate)).body).toMatchObject({status:'accepted',replayed:true,result:{revision:2,enabled:true}});
  expect((await post('/crm/processing/purpose/activate',{...activate,authorityReceiptId:stale})).body).toMatchObject({status:'refused'});
  expect((await post('/crm/capability/read',{capability:'crm_extraction'})).body).toMatchObject({revision:2,enabled:true,ready:true,configuration:{revision:2},proposedRevision:3,authorityReceiptId});
  expect((await post('/crm/processing/purpose/read',{})).body).toMatchObject({revision:2,enabled:true});
  expect((await post('/crm/processing/purpose/disable',command({capability:'crm_extraction',expectedRevision:2}))).body).toMatchObject({status:'accepted',result:{revision:3,enabled:false,authorityReceiptId:null}});
  expect((await post('/crm/capability/read',{capability:'crm_extraction'})).body).toMatchObject({revision:3,enabled:false,ready:false,authorityReceiptId:null});
  expect((await post('/outreach/control/v2',{})).body).toEqual(before);
 });
 it('keeps Ask answer saves disabled, rejects diagnostic authority and clears activation on a new save',async()=>{
  const payload={purpose:'answer',enabled:false,endpointId:'synthetic-current-route',modelVersion:'synthetic-model-v1',accessGrantVersion:'independent-grant-v1',dataHandlingVersion:'independent-handling-v1',evaluationFingerprint:'a'.repeat(64),processorVersion:'ask-answer-v1',retrievalVersion:'lexical-original-v1',answerVersion:'literal-v1',supportVersion:'exact-original-v1',chunkerVersion:'lexical-original-v1',dailyCeilingCents:10,monthlyCeilingCents:100,inputTokenPriceMicros:1,outputTokenPriceMicros:1};
  expect((await post('/ask/purpose/read',{capability:'ask_answer'})).body).toMatchObject({configured:false,enabled:false,ready:false,revision:0});
  expect((await post('/ask/purpose/save',command({...payload,expectedRevision:0,enabled:true}))).body).toMatchObject({status:'refused',reason:'activation_not_available'});
  expect((await post('/ask/purpose/save',command({...payload,expectedRevision:0}))).body).toMatchObject({status:'accepted',result:{revision:1,enabled:false}});
  const read=crmCapabilityReadResponseSchema.parse((await post('/ask/purpose/read',{capability:'ask_answer'})).body);
  if(!read.configuration)throw new Error('disabled Ask configuration missing');
  const diagnostic=await provision({...read.configuration,revision:2},'controlled_fixture');
  expect((await post('/ask/purpose/activate',command({capability:'ask_answer',expectedRevision:1,authorityReceiptId:diagnostic}))).body).toMatchObject({status:'refused',reason:'authority_unavailable'});
  const authorityReceiptId=await provision({...read.configuration,revision:2});
  expect((await post('/ask/purpose/activate',command({capability:'crm_extraction',expectedRevision:1,authorityReceiptId}))).body).toMatchObject({status:'refused',reason:'capability_path_mismatch'});
  expect((await post('/ask/purpose/activate',command({capability:'ask_answer',expectedRevision:1,authorityReceiptId,approved:true}))).status).toBe(400);
  expect((await post('/ask/purpose/activate',command({capability:'ask_answer',expectedRevision:1,authorityReceiptId}))).body).toMatchObject({status:'accepted',result:{revision:2,enabled:true}});
  expect((await post('/ask/purpose/read',{capability:'ask_answer'})).body).toMatchObject({revision:2,enabled:true,ready:true,configuration:{revision:2},proposedRevision:3});
  expect((await post('/ask/purpose/save',command({...payload,expectedRevision:2}))).body).toMatchObject({status:'accepted',result:{revision:3,enabled:false}});
  expect((await post('/ask/purpose/read',{capability:'ask_answer'})).body).toMatchObject({revision:3,enabled:false,ready:false,authorityReceiptId:null});
  expect((await post('/ask/purpose/disable',command({capability:'ask_answer',expectedRevision:3}))).body).toMatchObject({status:'accepted',result:{revision:4,enabled:false,authorityReceiptId:null}});
 });

 it('requires separate metadata and body authority and can disable capture after mailbox disconnect',async()=>{
  const mailbox=(await fixture.db.query<{id:string}>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'synthetic-capture@example.test','synthetic-capture-google','connected') RETURNING id",[fixture.alpha.workspaceId,fixture.alpha.admin.userId])).rows[0];if(!mailbox)throw new Error('synthetic mailbox missing');
  const policy=businessPolicySchema.parse((await post('/crm/business/policy/read',{mailboxId:mailbox.id})).body);if(!policy.generation||!policy.accountBinding)throw new Error('mailbox binding missing');
  expect((await post('/crm/business/policy/save',command({mailboxId:mailbox.id,expectedRevision:0,expectedGeneration:policy.generation,expectedAccountBinding:policy.accountBinding,enabled:false,disclosure:policy.metadataReviewDisclosure}))).body).toMatchObject({status:'accepted',result:{revision:1}});
  const configured=crmCapabilityReadResponseSchema.parse((await post('/crm/capability/read',{capability:'metadata_review',mailboxId:mailbox.id})).body);expect(configured).toMatchObject({revision:1,enabled:false,ready:false});if(!configured.configuration)throw new Error('metadata configuration missing');
  const observed=(await fixture.db.query<{id:string}>("INSERT INTO mailbox_oauth_grant_observations(workspace_id,mailbox_id,owner_user_id,provider_account_id,generation,granted_scopes) VALUES($1,$2,$3,'synthetic-capture-google',$4,$5) RETURNING id",[fixture.alpha.workspaceId,mailbox.id,fixture.alpha.admin.userId,policy.generation,['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send']])).rows[0];if(!observed)throw new Error('synthetic observed grant missing');
  const metadataAuthority=await provision({...configured.configuration,revision:2},'actual_acceptance',observed.id);
  expect((await post('/crm/business/policy/activate',command({capability:'metadata_review',mailboxId:mailbox.id,expectedRevision:1,authorityReceiptId:metadataAuthority}))).body).toMatchObject({status:'accepted',result:{revision:2,enabled:true}});
  expect((await post('/crm/capability/read',{capability:'metadata_review',mailboxId:mailbox.id})).body).toMatchObject({enabled:true,ready:true,revision:2});
  const save={mailboxId:mailbox.id,expectedRevision:0,expectedGeneration:policy.generation,expectedAccountBinding:policy.accountBinding,policyRevision:2,disclosureVersion:CRM_MAIL_CAPTURE_DISCLOSURE.version,disclosureSha256:CRM_MAIL_CAPTURE_DISCLOSURE.sha256,grantReceipt:'synthetic grant',providerPolicyReceipt:'synthetic policy',evaluationReceipt:'synthetic acceptance',releaseReceipt:releaseReference};
  expect((await post('/crm/business/mail/controls/save',command(save))).body).toMatchObject({status:'accepted',result:{revision:1,enabled:false}});
  const capture=crmCapabilityReadResponseSchema.parse((await post('/crm/capability/read',{capability:'mail_capture',mailboxId:mailbox.id})).body);if(!capture.configuration)throw new Error('capture configuration missing');
  expect((await post('/crm/business/mail/controls/activate',command({capability:'mail_capture',mailboxId:mailbox.id,expectedRevision:1,authorityReceiptId:metadataAuthority}))).body).toMatchObject({status:'refused',reason:'authority_unavailable'});
  const captureAuthority=await provision({...capture.configuration,revision:2},'actual_acceptance',observed.id);
  expect((await post('/crm/business/mail/controls/activate',command({capability:'mail_capture',mailboxId:mailbox.id,expectedRevision:1,authorityReceiptId:captureAuthority}))).body).toMatchObject({status:'accepted',result:{revision:2,enabled:true}});
  expect((await post('/crm/capability/read',{capability:'mail_capture',mailboxId:mailbox.id})).body).toMatchObject({enabled:true,ready:true,revision:2});
  await fixture.db.query("UPDATE mailboxes SET status='disconnected',disconnected_at=clock_timestamp(),generation=generation+1 WHERE workspace_id=$1 AND id=$2",[fixture.alpha.workspaceId,mailbox.id]);
  expect((await post('/crm/capability/read',{capability:'mail_capture',mailboxId:mailbox.id})).body).toMatchObject({enabled:true,ready:false});
  expect((await post('/crm/business/mail/controls/disable',command({capability:'mail_capture',mailboxId:mailbox.id,expectedRevision:2}))).body).toMatchObject({status:'accepted',result:{revision:3,enabled:false,authorityReceiptId:null}});
  expect((await post('/crm/business/policy/disable',command({capability:'metadata_review',mailboxId:mailbox.id,expectedRevision:2}))).body).toMatchObject({status:'accepted',result:{revision:3,enabled:false,authorityReceiptId:null}});
 });

 it('uses activated current extraction authority in the registered worker and settles usage after authority revocation',async()=>{
  const read=crmCapabilityReadResponseSchema.parse((await post('/crm/capability/read',{capability:'crm_extraction'})).body);if(!read.configuration)throw new Error('extraction config missing');
  const authorityReceiptId=await provision({...read.configuration,revision:4});
  expect((await post('/crm/processing/purpose/activate',command({capability:'crm_extraction',expectedRevision:3,authorityReceiptId}))).body).toMatchObject({status:'accepted',result:{revision:4}});
  const verifierDb=await fixture.database.appRuntimeSession();
  const verifiers=createCrmCapabilityVerifiers({runtime:{...runtime,side:'worker',imageDigest:FIXTURE_WORKER_DIGEST},openSession:async()=>({session:verifierDb,close:async()=>{}})});
  const personId=z.object({result:z.object({personId:z.uuid()})}).parse((await post('/crm/people/create',command({fullName:'Synthetic authority owner contact'}))).body).result.personId;
  const text='We need help.';
  for(const revokedDuringWait of [false,true]){
   const sourceId=z.object({result:z.object({sourceId:z.uuid()})}).parse((await post('/crm/people/source/add',command({personId,sourceKey:revokedDuringWait?'synthetic-revocation':'synthetic-current',excerpt:text,occurredAt:'2026-10-01T14:00:00Z'}))).body).result.sourceId;
   const selected=personPageSchema.parse((await post('/crm/people/read',{personId})).body).sources.find(source=>source.sourceId===sourceId);if(!selected)throw new Error('selected original missing');
   const source={workspaceId:selected.workspaceId,sourceId,kind:selected.kind,revision:selected.revision,contentHash:selected.contentHash,locator:null};
   expect((await post('/crm/processing/request',command({source}))).status).toBe(200);
   let transferred=false;
   const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmExtraction:{verifyPurpose:verifiers.verifyExtraction,revalidatePurpose:verifiers.revalidateExtraction,adapter:{endpointId:'synthetic-current-route',modelVersion:'synthetic-model-v1',accessGrantVersion:'independent-grant-v1',dataHandlingVersion:'independent-handling-v1',providerKey:'aws_bedrock.synthetic_crm',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async input=>{
    expect(input.text).toBe(text);transferred=true;
    if(revokedDuringWait){await fixture.db.query('SET ROLE migration');try{expect(await revokeCrmCapabilityAuthority(fixture.db,{workspaceId:fixture.alpha.workspaceId,authorityReceiptId,reference:'synthetic revoked during wait'})).toMatchObject({ok:true,value:{revoked:true}});}finally{await fixture.db.query('RESET ROLE');}}
    return {acceptance:'accepted',usage:{inputTokens:20,outputTokens:10},claims:[{kind:'need',status:'stated',interpretation:'Needs help',locator:'text:0:13',quote:text}]};
   }}}});
   await runOnce(runtimeDb,{registry,owner:'synthetic-authority-worker',limit:20});
   const result=crmProcessingResultSchema.parse((await post('/crm/processing/read',{source})).body);expect(transferred).toBe(true);
   if(revokedDuringWait)expect(result).toMatchObject({state:'stale',claims:[],financial:{dispatchState:'settled',settlementState:'settled',settledCents:1}});
   else expect(result).toMatchObject({state:'complete',purposeRevision:4,claims:[{quote:text}],financial:{dispatchState:'settled',settlementState:'settled',settledCents:1}});
  }
  expect((await post('/crm/capability/read',{capability:'crm_extraction'})).body).toMatchObject({enabled:true,ready:false,revision:4});
 });

 it('refuses evaluation A as authority for configured Ask evaluation B, including a malformed independently stored receipt',async()=>{
  const current=crmCapabilityReadResponseSchema.parse((await post('/ask/purpose/read',{capability:'ask_answer'})).body);if(!current.configuration||current.configuration.capability!=='ask_answer')throw new Error('Ask config missing');
  const {capability:_,workspaceId:__,ownerUserId:___,revision:____,...payload}=current.configuration;void _;void __;void ___;void ____;
  expect((await post('/ask/purpose/save',command({...payload,enabled:false,expectedRevision:4,evaluationFingerprint:'b'.repeat(64)}))).body).toMatchObject({status:'accepted',result:{revision:5,enabled:false}});
  const read=crmCapabilityReadResponseSchema.parse((await post('/ask/purpose/read',{capability:'ask_answer'})).body);if(!read.configuration)throw new Error('Ask config missing');
  const basis=receiptFor({...read.configuration,revision:6});const mismatched={...basis,proof:{...basis.proof,evaluationFingerprint:'a'.repeat(64)}};
  expect(mismatched.proof.evaluationFingerprint).toBe('a'.repeat(64));
  await fixture.db.query('SET ROLE migration');
  try{
   expect(await provisionCrmCapabilityAuthority(fixture.db,mismatched)).toMatchObject({ok:false});
   // Simulate an invalid historical/operator row; normal provisioning refuses it.
   await fixture.db.query(`INSERT INTO crm_capability_authority_receipts(workspace_id,id,capability,owner_user_id,configuration_sha256,authority_sha256,receipt,reviewed_by,review_reference,verified_at,valid_until) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)`,[mismatched.configuration.workspaceId,mismatched.id,mismatched.configuration.capability,mismatched.configuration.ownerUserId,mismatched.configurationFingerprint,createHash('sha256').update(JSON.stringify(mismatched)).digest('hex'),JSON.stringify(mismatched),mismatched.reviewedBy,mismatched.reviewReference,mismatched.verifiedAt,mismatched.validUntil]);
  }finally{await fixture.db.query('RESET ROLE');}
  expect((await post('/ask/purpose/activate',command({capability:'ask_answer',expectedRevision:5,authorityReceiptId:mismatched.id}))).body).toMatchObject({status:'refused',reason:'authority_unavailable'});
  expect((await post('/ask/purpose/read',{capability:'ask_answer'})).body).toMatchObject({revision:5,enabled:false,ready:false});
 });

 it('refuses default runtime and unsupported semantic versions even with a representative receipt',async()=>{
  const current=crmCapabilityReadResponseSchema.parse((await post('/ask/purpose/read',{capability:'ask_answer'})).body);if(!current.configuration||current.configuration.capability!=='ask_answer')throw new Error('Ask config missing');
  const authorityReceiptId=await provision({...current.configuration,revision:6});
  expect((await post('/ask/purpose/read',{capability:'ask_answer'},token,false)).body).toMatchObject({enabled:false,ready:false});
  expect((await post('/ask/purpose/activate',command({capability:'ask_answer',expectedRevision:5,authorityReceiptId}),token,false)).body).toMatchObject({status:'refused',reason:'authority_unavailable'});
  expect((await post('/ask/purpose/read',{capability:'ask_answer'})).body).toMatchObject({revision:5,enabled:false,ready:true,proposedRevision:6});
  const {capability:_,workspaceId:__,ownerUserId:___,revision:____,...payload}=current.configuration;void _;void __;void ___;void ____;
  expect((await post('/ask/purpose/save',command({...payload,enabled:false,expectedRevision:5,retrievalVersion:'unimplemented-semantic-vector-v1'}))).body).toMatchObject({status:'accepted',result:{revision:6,enabled:false}});
  const unsupported=crmCapabilityReadResponseSchema.parse((await post('/ask/purpose/read',{capability:'ask_answer'})).body);if(!unsupported.configuration)throw new Error('unsupported disabled Ask config missing');
  const semanticAuthority=await provision({...unsupported.configuration,revision:7});
  expect((await post('/ask/purpose/activate',command({capability:'ask_answer',expectedRevision:6,authorityReceiptId:semanticAuthority}))).body).toMatchObject({status:'refused',reason:'authority_unavailable'});
  expect((await post('/ask/purpose/read',{capability:'ask_answer'})).body).toMatchObject({revision:6,enabled:false,ready:false});
  expect((await post('/ask/purpose/activate',command({capability:'embedding',expectedRevision:6,authorityReceiptId:semanticAuthority}))).status).toBe(400);
  expect((await post('/ask/purpose/disable',command({capability:'ask_answer',expectedRevision:6}))).body).toMatchObject({status:'accepted',result:{revision:7,enabled:false}});
 });

 it('keeps authority-free stop/save available and refuses commands from other roles or workspaces',async()=>{
  expect((await post('/crm/processing/purpose/disable',command({capability:'crm_extraction',expectedRevision:4}))).body).toMatchObject({status:'accepted',result:{revision:5,enabled:false,authorityReceiptId:null}});
  expect((await post('/crm/processing/purpose/save',command({expectedRevision:5,enabled:false,endpointId:'synthetic-current-route',modelVersion:'synthetic-model-v1',accessGrantVersion:'independent-grant-v1',dataHandlingVersion:'independent-handling-v1',dailyCeilingCents:10,monthlyCeilingCents:100,inputTokenPriceMicros:1,outputTokenPriceMicros:1}))).body).toMatchObject({status:'accepted',result:{revision:6,enabled:false}});
  expect((await post('/crm/capability/read',{capability:'crm_extraction'})).body).toMatchObject({revision:6,enabled:false,ready:false,authorityReceiptId:null});
  const salesperson=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
  expect((await post('/ask/purpose/disable',command({capability:'ask_answer',expectedRevision:7}),salesperson)).body).toMatchObject({status:'refused',reason:'capability_access_denied'});
  const otherWorkspace=(await issueSessionFor(fixture,fixture.beta,fixture.beta.admin)).accessToken;
  expect((await post('/crm/processing/purpose/disable',command({capability:'crm_extraction',expectedRevision:6}),otherWorkspace)).body).toMatchObject({status:'refused'});
  expect((await post('/crm/capability/read',{capability:'crm_extraction'})).body).toMatchObject({revision:6,enabled:false});
  expect((await post('/ask/purpose/read',{capability:'crm_extraction'})).status).toBe(400);
  for(const path of paths){expect((await dispatch({method:'GET',path,body:{},query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:runtimeDb,auth:{...fixture.deps,db:runtimeDb},supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false})).status,path).toBe(405);}
 });

});
