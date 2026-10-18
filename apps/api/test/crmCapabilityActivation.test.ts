import {businessPolicySchema,CRM_OWNER_SCOPE_VERSION} from '@fss/contracts';
import {CRM_MAIL_CAPTURE_DISCLOSURE} from '@fss/domain/crm/capabilityAuthority.ts';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {dispatch} from '../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import type {SessionQueryable} from '@fss/domain/db/queryable.ts';
import type {CrmCapabilityRuntime} from '@fss/domain/crm/capabilityAuthority.ts';
let fixture:AuthFixture, token:string, db:SessionQueryable, captureApprovalId:string;
const runtime:CrmCapabilityRuntime={implementationCommit:null,imageDigest:null,side:'api',schemaVersion:100,adapterAvailable:()=>true};
const command=(body:Record<string,unknown>)=>({...body,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
const post=(path:string,body:unknown,run=runtime)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:db,auth:{...fixture.deps,db},supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,crmCapabilityRuntime:run});
beforeAll(async()=>{
 fixture=await createAuthFixture();token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;db=await fixture.database.appRuntimeSession();
 const mailbox=(await fixture.db.query<{id:string}>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'scoped@example.test','scope-google','connected') RETURNING id",[fixture.alpha.workspaceId,fixture.alpha.admin.userId])).rows[0]!;
 const policy=businessPolicySchema.parse((await post('/crm/business/policy/read',{mailboxId:mailbox.id})).body);
 const approval={consentAcknowledged:true,qualityTier:'acquisition',limitations:[]};
 await post('/crm/business/policy/save',command({mailboxId:mailbox.id,expectedRevision:0,expectedGeneration:policy.generation,expectedAccountBinding:policy.accountBinding,enabled:false,disclosure:policy.metadataReviewDisclosure}));
 await fixture.db.query("INSERT INTO mailbox_oauth_grant_observations(workspace_id,mailbox_id,owner_user_id,provider_account_id,generation,granted_scopes) VALUES($1,$2,$3,'scope-google',$4,$5)",[fixture.alpha.workspaceId,mailbox.id,fixture.alpha.admin.userId,policy.generation,['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send']]);
 await post('/crm/business/policy/activate',command({capability:'metadata_review',mailboxId:mailbox.id,expectedRevision:1,approval}));
 await post('/crm/business/mail/controls/save',command({mailboxId:mailbox.id,expectedRevision:0,expectedGeneration:policy.generation,expectedAccountBinding:policy.accountBinding,policyRevision:2,disclosureVersion:CRM_MAIL_CAPTURE_DISCLOSURE.version,disclosureSha256:CRM_MAIL_CAPTURE_DISCLOSURE.sha256}));
 expect((await post('/crm/business/mail/controls/activate',command({capability:'mail_capture',mailboxId:mailbox.id,expectedRevision:1,approval,scopeVersion:CRM_OWNER_SCOPE_VERSION}))).body).toMatchObject({status:'accepted'});
 captureApprovalId=(await fixture.db.query<{owner_approval_id:string}>('SELECT owner_approval_id FROM crm_mail_capture_controls WHERE workspace_id=$1 AND mailbox_id=$2',[fixture.alpha.workspaceId,mailbox.id])).rows[0]!.owner_approval_id;
});
afterAll(async()=>fixture.stop());
it('owner explicitly approves prepared extraction and unchanged releases preserve enablement without privileged receipts',async()=>{
 expect((await post('/crm/processing/purpose/save',command({expectedRevision:0,enabled:false,allowedSourceKinds:['mail'],mailCaptureOwnerApprovalId:captureApprovalId,endpointId:'test-route',modelVersion:'test-model',accessGrantVersion:'approved-access-v1',dataHandlingVersion:'no-retention-v1',dailyCeilingCents:10,monthlyCeilingCents:100,inputTokenPriceMicros:1,outputTokenPriceMicros:1}))).body).toMatchObject({status:'accepted',result:{revision:1,enabled:false}});
 expect((await post('/crm/capability/read',{capability:'crm_extraction'})).body).toMatchObject({enabled:false,ready:true,reason:'owner_consent_required'});
 expect((await post('/crm/processing/purpose/activate',command({capability:'crm_extraction',scopeVersion:CRM_OWNER_SCOPE_VERSION,expectedRevision:1,approval:{consentAcknowledged:true,qualityTier:'provisional_owner',criticalControlsPassed:true,modelIntegrationVerified:true,reviewedEvaluationReference:'reviewed-cases-v1',limitations:['representative_quality_unverified']}}))).body).toMatchObject({status:'accepted',result:{revision:2,enabled:true}});
 expect((await post('/crm/capability/read',{capability:'crm_extraction'},{...runtime,implementationCommit:'a'.repeat(40),imageDigest:`sha256:${'b'.repeat(64)}`})).body).toMatchObject({enabled:true,ready:true,qualityTier:'provisional_owner',reason:'ready'});
});
it('requires actual configured adapters and complete provisional review, without treating a disabled save as consent',async()=>{
 const approval={consentAcknowledged:true,qualityTier:'provisional_owner',criticalControlsPassed:true,modelIntegrationVerified:true,reviewedEvaluationReference:'reviewed-cases-v1',limitations:['representative_quality_unverified']};
 expect((await post('/crm/processing/purpose/activate',command({capability:'crm_extraction',scopeVersion:CRM_OWNER_SCOPE_VERSION,expectedRevision:2,approval:{...approval,limitations:[]}}))).body).toMatchObject({status:'refused',reason:'quality_review_required'});
 expect((await post('/crm/processing/purpose/activate',command({capability:'crm_extraction',scopeVersion:CRM_OWNER_SCOPE_VERSION,expectedRevision:2,approval}),{...runtime,adapterAvailable:()=>false})).body).toMatchObject({status:'refused',reason:'owner_consent_unavailable'});
 expect((await post('/crm/processing/purpose/activate',command({capability:'crm_extraction',scopeVersion:CRM_OWNER_SCOPE_VERSION,expectedRevision:1,approval}))).body).toMatchObject({status:'refused',reason:'capability_revision_conflict'});
 expect((await post('/crm/processing/purpose/activate',command({capability:'crm_extraction',scopeVersion:CRM_OWNER_SCOPE_VERSION,expectedRevision:2,authorityReceiptId:randomUUID()}))).status).toBe(400);
 expect((await post('/crm/capability/read',{capability:'crm_extraction'})).body).toMatchObject({revision:2,enabled:true,ready:true});
});
it('changed provider, model, handling or spending settings require fresh explicit owner approval',async()=>{
 expect((await post('/crm/processing/purpose/save',command({expectedRevision:2,enabled:false,allowedSourceKinds:['mail'],mailCaptureOwnerApprovalId:captureApprovalId,endpointId:'new-route',modelVersion:'new-model',accessGrantVersion:'new-access',dataHandlingVersion:'new-handling',dailyCeilingCents:20,monthlyCeilingCents:200,inputTokenPriceMicros:1,outputTokenPriceMicros:1}))).body).toMatchObject({status:'accepted',result:{revision:3,enabled:false}});
 expect((await post('/crm/capability/read',{capability:'crm_extraction'})).body).toMatchObject({revision:3,enabled:false,ownerApprovalId:null,reason:'owner_consent_required'});
 expect((await post('/crm/processing/purpose/disable',command({capability:'crm_extraction',expectedRevision:3}))).body).toMatchObject({status:'accepted',result:{revision:4,enabled:false,ownerApprovalId:null}});
});
it('separately approves metadata and body capture with observed OAuth scopes and no fabricated legacy references',async()=>{
 const mailbox=(await fixture.db.query<{id:string}>("UPDATE mailboxes SET status='disconnected',generation=generation+1,disconnected_at=clock_timestamp() WHERE workspace_id=$1 AND owner_user_id=$2 RETURNING id",[fixture.alpha.workspaceId,fixture.alpha.admin.userId])).rows[0]!;
 await fixture.db.query("UPDATE mailboxes SET status='connected',disconnected_at=NULL WHERE workspace_id=$1 AND id=$2",[fixture.alpha.workspaceId,mailbox.id]);
 const policy=businessPolicySchema.parse((await post('/crm/business/policy/read',{mailboxId:mailbox.id})).body);
 const approval={consentAcknowledged:true,qualityTier:'acquisition',limitations:[]};
 expect((await post('/crm/business/policy/save',command({mailboxId:mailbox.id,expectedRevision:2,expectedGeneration:policy.generation,expectedAccountBinding:policy.accountBinding,enabled:false,disclosure:policy.metadataReviewDisclosure}))).body).toMatchObject({status:'accepted',result:{revision:3}});
 expect((await post('/crm/business/policy/activate',command({capability:'metadata_review',mailboxId:mailbox.id,expectedRevision:3,approval}))).body).toMatchObject({status:'refused',reason:'owner_consent_unavailable'});
 await fixture.db.query("INSERT INTO mailbox_oauth_grant_observations(workspace_id,mailbox_id,owner_user_id,provider_account_id,generation,granted_scopes) VALUES($1,$2,$3,'scope-google',$4,$5)",[fixture.alpha.workspaceId,mailbox.id,fixture.alpha.admin.userId,policy.generation,['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send']]);
 expect((await post('/crm/business/policy/activate',command({capability:'metadata_review',mailboxId:mailbox.id,expectedRevision:3,approval}))).body).toMatchObject({status:'accepted',result:{revision:4,enabled:true}});
 expect((await post('/crm/business/mail/controls/save',command({mailboxId:mailbox.id,expectedRevision:2,expectedGeneration:policy.generation,expectedAccountBinding:policy.accountBinding,policyRevision:4,disclosureVersion:CRM_MAIL_CAPTURE_DISCLOSURE.version,disclosureSha256:CRM_MAIL_CAPTURE_DISCLOSURE.sha256}))).body).toMatchObject({status:'accepted',result:{revision:3,enabled:false}});
 expect((await post('/crm/business/mail/controls/activate',command({capability:'mail_capture',mailboxId:mailbox.id,expectedRevision:3,approval,scopeVersion:CRM_OWNER_SCOPE_VERSION}))).body).toMatchObject({status:'accepted',result:{revision:4,enabled:true}});
 expect((await post('/crm/capability/read',{capability:'mail_capture',mailboxId:mailbox.id})).body).toMatchObject({enabled:true,ready:true,configuration:{grantReceipt:null,providerPolicyReceipt:null,evaluationReceipt:null,releaseReceipt:null}});
 expect((await post('/crm/business/policy/disable',command({capability:'metadata_review',mailboxId:mailbox.id,expectedRevision:4}))).body).toMatchObject({status:'accepted'});
 expect((await post('/crm/capability/read',{capability:'mail_capture',mailboxId:mailbox.id})).body).toMatchObject({enabled:true,ready:false});
 await fixture.db.query("UPDATE mailboxes SET status='disconnected',generation=generation+1,disconnected_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[fixture.alpha.workspaceId,mailbox.id]);
 expect((await post('/crm/business/mail/controls/disable',command({capability:'mail_capture',mailboxId:mailbox.id,expectedRevision:4}))).body).toMatchObject({status:'accepted',result:{revision:5,enabled:false}});
});
it('stops owner capability access after membership departure',async()=>{
 await fixture.db.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[fixture.alpha.workspaceId,fixture.alpha.salesperson.userId]);
 await fixture.db.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2",[fixture.alpha.workspaceId,fixture.alpha.admin.userId]);
 expect((await post('/crm/capability/read',{capability:'crm_extraction'})).status).toBe(401);
});
