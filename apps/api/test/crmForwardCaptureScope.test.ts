import {randomUUID} from 'node:crypto';
import {afterEach,expect,it} from 'vitest';
import {businessPolicySchema,CRM_MAIL_CAPTURE_CONSENT,CRM_OWNER_SCOPE_VERSION,crmCapabilityReadResponseSchema} from '@fss/contracts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {dispatch} from '../src/server.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {claimJobs} from '@fss/domain/jobs/jobStore.ts';
import {businessMailCaptureHandler,createApprovedBusinessMailObserver} from '@fss/domain/mail/crmSources.ts';
import {createGmailMailCaptureProvider} from '@fss/domain/mail/crmGmailProvider.ts';
import {createGmailHttpClient} from '@fss/domain/mail/gmailClientHttp.ts';
import {createCrmCapabilityVerifiers} from '@fss/domain/crm/capabilityVerifiers.ts';
import {forwardCaptureScopeForApproval,isForwardCaptureDateAllowed} from '@fss/domain/mail/crmForwardCaptureScope.ts';

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
 async function capture(messageId:string,at:number,sent=false,afterBody?:()=>Promise<void>){
  let bodyReads=0,metadataReads=0;
  const gmail=createGmailHttpClient({apiBaseUrl:'https://controlled.invalid',fetch:async url=>{
   const full=new URL(url).searchParams.get('format')==='full';if(full){bodyReads++;await afterBody?.();}else metadataReads++;
   return {status:200,headers:{},body:JSON.stringify({id:messageId,threadId:'business_thread',internalDate:String(at),labelIds:[sent?'SENT':'INBOX'],payload:{mimeType:'text/plain',headers:[{name:'From',value:sent?'owner@example.test':'person@example.test'},{name:'To',value:sent?'person@example.test':'owner@example.test'},{name:'Subject',value:'Business proposal'}],body:full?{data:Buffer.from('Controlled current business original.').toString('base64url')}:{}}})};
  }});
  const provider=createGmailMailCaptureProvider({gmail,authorizeRead:verifiers.captureVerifier.verify,resolveAccess:async()=>({mailboxId:mailbox.id,providerAccountId:'google-owner',generation:policy.generation!,mailboxEmail:'owner@example.test',access:{accessToken:'controlled-fixture-only',expiresAtEpochSeconds:Date.now()/1000+3600}})});
  const job=(await claimJobs(db,{owner:randomUUID(),kinds:['crm.mail_capture'],limit:1,leaseSeconds:120}))[0];
  expect(job).toBeDefined();
  const result=await businessMailCaptureHandler({provider,proofVerifier:verifiers.captureVerifier}).handle({session:db,scope:context.scope,job:job!});
  return {result,bodyReads,metadataReads};
 }
 return {f,db,post,command,mailbox,policy,read,activation,activate,acquisition,context,observe,capture};
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

it('does not create older CRM metadata or jobs, and captures new incoming and Sent originals through real provider/parser/PG',async()=>{
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
