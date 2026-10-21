import { randomUUID } from 'node:crypto';
import { CRM_OWNER_SCOPE_VERSION } from '@fss/contracts';
import { createAuthFixture } from './authFixture.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { businessAccountBinding, METADATA_REVIEW_DISCLOSURE } from '@fss/domain/business/acquisition.ts';
import { activateCrmCapability, CRM_MAIL_CAPTURE_DISCLOSURE } from '@fss/domain/crm/capabilityAuthority.ts';
import { envelopeCipher, localDataKeyWrapper } from '@fss/domain/mail/envelope.ts';
import { storeRefreshToken } from '@fss/domain/mail/tokens.ts';
import { recordedGmailClient } from '@fss/domain/mail/gmailClientFake.ts';
import { captureReadAuthority } from '@fss/domain/mail/crmCaptureReadAuthority.ts';
import { requestCaptureReadRecovery } from '@fss/domain/mail/crmCaptureReadRecovery.ts';
import { enqueueJob, claimJobs, completeJob } from '@fss/domain/jobs/jobStore.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { registerHandlers } from '../../../worker/src/bootstrap/main.ts';
import { createCrmCapabilityVerifiers } from '@fss/domain/crm/capabilityVerifiers.ts';
import { createApprovedBusinessMailObserver } from '@fss/domain/mail/crmSources.ts';
import type { GmailClient } from '@fss/domain/mail/gmailClient.ts';

export async function captureRecoveryFixture(){
 const fixture=await createAuthFixture(),db=fixture.db,w=fixture.alpha.workspaceId,owner=fixture.alpha.admin.userId;
 try {
 const m=(await db.query<{id:string;owner_user_id:string;email_address:string;provider_account_id:string;generation:number;status:string}>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'business@example.test','capture-provider','connected') RETURNING *",[w,owner])).rows[0]!;
 const binding=businessAccountBinding(w,m),session=await fixture.database.appRuntimeSession();
 const context=repositoryContext(workspaceScope(w,{kind:'user',userId:owner,role:'admin'}),session);
 const system=repositoryContext(workspaceScope(w,{kind:'system',component:'worker'}),session);
 const runtime={implementationCommit:null,imageDigest:null,side:'worker' as const,schemaVersion:129,adapterAvailable:()=>true};
 const cipher=envelopeCipher(localDataKeyWrapper());
 await storeRefreshToken(context,{mailboxId:m.id,plaintext:randomUUID(),cipher});
 await db.query('INSERT INTO mailbox_oauth_grant_observations(workspace_id,mailbox_id,owner_user_id,provider_account_id,generation,granted_scopes) VALUES($1,$2,$3,$4,1,$5)',[w,m.id,owner,m.provider_account_id,['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send']]);
 await db.query('INSERT INTO crm_business_policies(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled,disclosure_version,disclosure_sha256) VALUES($1,$2,$3,$4,$5,1,1,false,$6,$7)',[w,m.id,owner,m.provider_account_id,binding,METADATA_REVIEW_DISCLOSURE.version,METADATA_REVIEW_DISCLOSURE.sha256]);
 const approval={consentAcknowledged:true as const,qualityTier:'acquisition' as const,limitations:[]};
 const policy=await withTransaction(session,()=>activateCrmCapability(context,{capability:'metadata_review',mailboxId:m.id,expectedRevision:1,approval},runtime));
 if(!policy.ok)throw new Error('fixture_metadata_authority');
 await db.query('INSERT INTO crm_mail_capture_controls(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled,policy_revision,disclosure_version,disclosure_sha256) VALUES($1,$2,$3,$4,$5,1,1,false,2,$6,$7)',[w,m.id,owner,m.provider_account_id,binding,CRM_MAIL_CAPTURE_DISCLOSURE.version,CRM_MAIL_CAPTURE_DISCLOSURE.sha256]);
 const consent=await withTransaction(session,()=>activateCrmCapability(context,{capability:'mail_capture',mailboxId:m.id,expectedRevision:1,scopeVersion:CRM_OWNER_SCOPE_VERSION,approval},runtime));
 if(!consent.ok)throw new Error('fixture_capture_authority');
 const incident=(await db.query<{id:string}>("INSERT INTO mailbox_provider_incidents(workspace_id,mailbox_id,source_kind,source_id,classification,reason,observed_at) VALUES($1,$2,'token_refresh','capture-fixture','transient','rate_limited',clock_timestamp()) RETURNING id",[w,m.id])).rows[0]!.id;
 const fake=recordedGmailClient({emailAddress:m.email_address,historyId:'100',messages:[]});
 const oauth={clientId:'local-fixture',clientSecret:randomUUID(),redirectUri:'http://127.0.0.1/callback',authorizationEndpoint:'https://oauth.example.test/authorize',tokenEndpoint:'https://oauth.example.test/token',revocationEndpoint:'https://oauth.example.test/revoke',apiBaseUrl:'https://gmail.example.test'};
 const verifiers=createCrmCapabilityVerifiers({runtime,openSession:async()=>({session:await fixture.database.appRuntimeSession(),close:async()=>{}})});
 const observer=createApprovedBusinessMailObserver({revalidateAuthority:verifiers.revalidateMetadata});
 async function request(){return withTransaction(session,async()=>{const a=await captureReadAuthority(context,m.id,runtime);if(!a.ok)throw new Error(a.reason);return requestCaptureReadRecovery(context,{mailboxId:m.id,expectedGeneration:1,incidentId:incident,expectedRecoveryBinding:a.authority.binding},runtime);});}
 async function run(kind:'crm.capture_read_recovery'|'crm.capture_read_forward',gmail:GmailClient=fake){
  const job=(await claimJobs(session,{owner:'capture-recovery-test',kinds:[kind],limit:1,leaseSeconds:120}))[0];
  if(!job)throw new Error('fixture_job_absent');
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmCaptureRead:{gmail,oauth,cipher,runtime,observer}});
  await registry.get(kind)!.handle({scope:system.scope,session,job});
  await completeJob(session,job);return job;
 }
 async function nextForward(recoveryId:string){await enqueueJob(db,{workspaceId:w,kind:'crm.capture_read_forward',idempotencyKey:randomUUID(),payload:{recoveryId},maxAttempts:1});}
 return {fixture,db,w,owner,m,binding,context,system,session,runtime,cipher,incident,fake,oauth,verifiers,observer,request,run,nextForward,stop:()=>fixture.stop()};
 }catch(error){await fixture.stop();throw error;}
}
