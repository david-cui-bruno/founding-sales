import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {routeReplyComposer} from '../src/routes/replyComposer.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {recordMessage,storeMessageBody} from '@fss/domain/mail/messages.ts';
import {recordMatches} from '@fss/domain/mail/matching.ts';
import {setProspectingAuthorization} from '@fss/domain/outreach/authorization.ts';
import {readReplyDraftContext} from '@fss/domain/replies/composer.ts';
import type {HumanReplyDraftPort} from '@fss/domain/replies/composerGeneration.ts';
import {revokeDevice} from '../src/auth/sessions.ts';
let f:AuthFixture,token:string;
beforeAll(async()=>{f=await createAuthFixture();token=(await issueSessionFor(f,f.alpha,f.alpha.salesperson)).accessToken;});
afterAll(async()=>f.stop());
const call=(path:string,body:unknown,authorized=true,port:HumanReplyDraftPort|null=null,accessToken=token)=>routeReplyComposer({method:'POST',path,query:new URLSearchParams(),headers:authorized?{authorization:`Bearer ${accessToken}`}:{},body},{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://example.test/update',suppressionJournal:{append:async()=>{}}},port);
async function conversation(){
 const owner=f.alpha.salesperson.userId,workspaceId=f.alpha.workspaceId,address=`owner-${randomUUID()}@example.test`,recipient=`prospect-${randomUUID()}@example.test`;
 const ctx=repositoryContext(workspaceScope(workspaceId,{kind:'user',userId:owner,role:'salesperson'}),f.db);
 const admin=repositoryContext(workspaceScope(workspaceId,{kind:'user',userId:f.alpha.admin.userId,role:'admin'}),f.db);
 const existing=(await f.db.query<{id:string;email_address:string}>('SELECT id,email_address FROM mailboxes WHERE workspace_id=$1 AND owner_user_id=$2',[workspaceId,owner])).rows[0];
 const mailbox=existing??(await f.db.query<{id:string;email_address:string}>(`INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,sync_state,history_id,history_id_updated_at,baseline_from_at,baseline_completed_at,coverage_watermark_at) VALUES($1,$2,$3,$3,'ready','1000',now(),now()-interval '30 days',now(),now()) RETURNING id,email_address`,[workspaceId,owner,address])).rows[0]!;
 const firm=(await f.db.query<{id:string}>('INSERT INTO firms(workspace_id,name,assigned_user_id) VALUES($1,$2,$3) RETURNING id',[workspaceId,'Composer fixture',owner])).rows[0]!;
 const contact=(await f.db.query<{id:string}>('INSERT INTO contacts(workspace_id,firm_id,full_name) VALUES($1,$2,$3) RETURNING id',[workspaceId,firm.id,'Robin Fixture'])).rows[0]!;
 const stage=(await f.db.query<{id:string}>('SELECT id FROM pipeline_stages WHERE workspace_id=$1 ORDER BY position LIMIT 1',[workspaceId])).rows[0]!;
 const opportunity=(await f.db.query<{id:string}>('INSERT INTO opportunities(workspace_id,firm_id,stage_id,control_mode_changed_at) VALUES($1,$2,$3,now()) RETURNING id',[workspaceId,firm.id,stage.id])).rows[0]!;
 await f.db.query("INSERT INTO email_addresses(workspace_id,firm_id,contact_id,address,source,retrieved_at,association_confidence,technical_validation,eligibility,eligibility_policy_version) VALUES($1,$2,$3,$4,'reply',now(),0.9,'passed','usable','fixture')",[workspaceId,firm.id,contact.id,recipient]);
 const auth=(await f.db.query<{revision:number}>('SELECT revision FROM gmail_prospecting_authorizations WHERE workspace_id=$1 AND mailbox_id=$2',[workspaceId,mailbox.id])).rows[0];
 await withTransaction(f.db,()=>setProspectingAuthorization(admin,{mailboxId:mailbox.id,expectedRevision:auth?.revision??0,enabled:true,basis:'owner_reported_google_permission'}));
 const id=randomUUID(),message=await withTransaction(f.db,()=>recordMessage(ctx,{mailboxId:mailbox.id,metadata:{providerMessageId:id,providerThreadId:id,rfcMessageId:`${id}@example.test`,direction:'incoming',internalDate:new Date().toISOString(),headerFrom:recipient,headerTo:[address],headerCc:[],subject:'Question',referenceMessageIds:[],inReplyTo:null,autoSubmitted:null,listId:null,labelIds:[],attachments:[]}}));
 await withTransaction(f.db,()=>recordMatches(ctx,{messageId:message.message.id,candidates:[{firmId:firm.id,contactId:contact.id,opportunityId:opportunity.id,rule:'participant',viaClosedOpportunity:false}]}));
 await withTransaction(f.db,()=>storeMessageBody(ctx,{messageId:message.message.id,text:'Could we discuss this?',truncated:false}));
 const source=await readReplyDraftContext(ctx,{messageId:message.message.id,factRefs:[]});if(!source.ok)throw new Error(source.reason);
 return {messageId:message.message.id,sourceRevision:source.value.sourceRevision,factRefs:[],envelope:source.value.envelope,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
}
it('requires a current authenticated session and strict context input without leaking body data',async()=>{
 expect((await call('/replies/composer/context',{messageId:randomUUID()},false))?.status).toBe(401);
 expect((await call('/replies/composer/context',{messageId:randomUUID(),authorUserId:f.alpha.admin.userId}))?.status).toBe(400);
 expect((await call('/replies/composer/context',{messageId:randomUUID()}))?.body).toEqual({ok:false,reason:'message_unavailable'});
});
it('refuses obsolete generation clients before any paid attempt',async()=>{
 const input={messageId:randomUUID(),sourceRevision:'a'.repeat(64),factRefs:[],envelope:{to:['prospect@example.test'],cc:[]},commandId:randomUUID(),clientVersion:'0.0.1'};
 expect((await call('/replies/composer/generate',input))?.body).toMatchObject({status:'refused',reason:'client_upgrade_required'});
 expect((await call('/replies/composer/generate',{...input,clientVersion:CURRENT_CLIENT_VERSION}))?.body).toMatchObject({status:'refused',reason:'message_unavailable'});
});

it('returns the accepted strict-client command envelope for an injected bounded suggestion',async()=>{
 const input=await conversation();let calls=0;
 const port:HumanReplyDraftPort={providerKey:'aws_bedrock.outreach_reply',countInputTokens:async()=>100,prepareReplyDraft:async()=>{calls++;return {raw:JSON.stringify({text:'Thank you for your question.',factRefs:[],unsupportedClaims:[]}),costCents:1,costEstimated:false};}};
 expect(await call('/replies/composer/generate',input,true,port)).toMatchObject({status:200,body:{status:'accepted',replayed:false,result:{ok:true,value:{text:'Thank you for your question.',reviewRequired:true}}}});
 expect(await call('/replies/composer/generate',input,true,port)).toMatchObject({status:409,body:{status:'refused',replayed:true,reason:'generation_already_attempted'}});
 expect(calls).toBe(1);
});

it('withholds generated prose when the authenticated device is revoked during generation',async()=>{
 const grant=await issueSessionFor(f,f.alpha,f.alpha.salesperson,{deviceLabel:'revoked composer fixture'}),input=await conversation();
 const port:HumanReplyDraftPort={providerKey:'aws_bedrock.outreach_reply',countInputTokens:async()=>100,prepareReplyDraft:async()=>{
  await withTransaction(f.db,()=>revokeDevice(f.deps,{workspaceId:f.alpha.workspaceId,deviceId:grant.deviceId,reason:'device_revoked'}));
  return {raw:JSON.stringify({text:'Private generated prose.',factRefs:[],unsupportedClaims:[]}),costCents:1,costEstimated:false};
 }};
 expect(await call('/replies/composer/generate',input,true,port,grant.accessToken)).toMatchObject({status:409,body:{status:'refused',reason:'session_changed'}});
});
