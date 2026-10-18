import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {z} from 'zod';
import {socialWorkspaceSchema} from '@fss/contracts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {runSocialDraft} from '@fss/domain/social/draftRun.ts';
import {registerHandlers,workerDueWorkSources} from '../../worker/src/bootstrap/main.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {dispatch} from '../src/server.ts';
let f:AuthFixture;
beforeAll(async()=>{
 const fixture=await createAuthFixture();
 // The common fixture deliberately requires 1.2+. Exercise a policy that admits
 // the installed build without bypassing any ordinary command version checks.
 f={...fixture,deps:{...fixture.deps,config:{...fixture.deps.config,supportedClientVersions:{...fixture.deps.config.supportedClientVersions,minimum:'1.0.51'}}}};
});
afterAll(async()=>f.stop());
const call=(token:string,path:string,body:unknown={})=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body},{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false});
const command=(body:Record<string,unknown>,version=CURRENT_CLIENT_VERSION)=>({...body,commandId:randomUUID(),clientVersion:version});
async function approved(){
 const grant=await issueSessionFor(f,f.alpha,f.alpha.admin),accountId=randomUUID();
 await f.db.query("INSERT INTO social_accounts(workspace_id,id,owner_user_id,platform,external_id,display_name,account_kind,state,adapter_version,verified_at,max_schedule_days) VALUES($1,$2,$3,'linkedin',$4,'Fixture','profile','connected','fixture-v1',now(),30)",[f.alpha.workspaceId,accountId,f.alpha.admin.userId,accountId]);
 const saved=await call(grant.accessToken,'/social/posts/save',command({accountId,text:'Manually approved fixture',images:[],publishAt:new Date(Date.now()+86400_000).toISOString(),zone:'America/New_York'}));
 expect(saved.status).toBe(200);
 const post=z.object({result:z.object({postId:z.uuid(),revision:z.number()})}).parse(saved.body).result;
 expect((await call(grant.accessToken,'/social/posts/approve',command({postId:post.postId,expectedRevision:post.revision}))).status).toBe(200);
 const delivery=(await f.db.query<{id:string;approval_id:string;fingerprint:string}>('SELECT d.id,d.approval_id,a.fingerprint FROM social_deliveries d JOIN social_post_approvals a ON a.workspace_id=d.workspace_id AND a.id=d.approval_id WHERE d.workspace_id=$1 AND d.post_id=$2',[f.alpha.workspaceId,post.postId])).rows[0]!;
 return {grant,accountId,postId:post.postId,deliveryId:delivery.id,approvalId:delivery.approval_id,fingerprint:delivery.fingerprint};
}
type Post=Awaited<ReturnType<typeof approved>>;
/** Seed retained historical records directly, never recreate removed authority. */
async function historical(p:Post,kind:'standing'|'candidate'){
 const w=f.alpha.workspaceId,u=f.alpha.admin.userId,draftId=randomUUID(),slotId=randomUUID(),sourceHash=draftId.replaceAll('-','').repeat(2);
 await f.db.query("INSERT INTO linkedin_posting_settings(workspace_id,owner_user_id,revision,state,policy) VALUES($1,$2,1,'saved','{}') ON CONFLICT DO NOTHING",[w,u]);
 await f.db.query("INSERT INTO linkedin_posting_policy_revisions(workspace_id,owner_user_id,revision,state,policy) VALUES($1,$2,1,'saved','{}') ON CONFLICT DO NOTHING",[w,u]);
 await f.db.query("INSERT INTO social_draft_requests(workspace_id,id,owner_user_id,source_selection,source_hash,prompt_version,model_name,state) VALUES($1,$2,$3,$4::jsonb,$5,'historical','historical','queued')",[w,draftId,u,JSON.stringify({mode:'linkedin_grounded'}),sourceHash]);
 await f.db.query("INSERT INTO linkedin_recurring_slots(workspace_id,id,owner_user_id,account_id,account_revision,policy_revision,target_at,source_selection,source_hash,draft_request_id,post_id,state) VALUES($1,$2,$3,$4,1,1,'2026-11-03T15:00:00Z',$5::jsonb,$6,$7,$8,'queued')",[w,slotId,u,p.accountId,JSON.stringify({mode:'linkedin_grounded'}),sourceHash,draftId,p.postId]);
 if(kind==='standing')await f.db.query("UPDATE social_post_approvals SET approval_kind='standing_policy',approved_by=NULL,standing_slot_id=$3 WHERE workspace_id=$1 AND id=$2",[w,p.approvalId,slotId]);
 else await f.db.query('INSERT INTO linkedin_posting_candidate_bindings(workspace_id,delivery_id,owner_user_id,policy_revision) VALUES($1,$2,$3,1)',[w,p.deliveryId,u]);
 return {draftId,slotId};
}
it('unmounts recurring posting and policy while retaining manual social and independent outreach policy',async()=>{
 const grant=await issueSessionFor(f,f.alpha,f.alpha.admin);
 for(const path of ['/social/linkedin-recurring/read',...['read','save','disable','revoke','check-current','bind-candidate','dispatch-current'].map(action=>`/social/linkedin-posting-policy/${action}`)])expect((await call(grant.accessToken,path)).status,path).toBe(404);
 expect((await call(grant.accessToken,'/social/linkedin-policy/read')).status).toBe(200);
 const workspace=await call(grant.accessToken,'/social');expect(workspace.status).toBe(200);expect(socialWorkspaceSchema.safeParse(workspace.body).success).toBe(true);
 const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined});
 expect(registry.get('social.linkedin_recurring')).toBeUndefined();expect(registry.get('social.draft')).toBeDefined();
 expect(workerDueWorkSources().some(source=>source.name==='linkedin-recurring')).toBe(false);
 expect(workerDueWorkSources().some(source=>source.name==='social-drafts')).toBe(true);
});
for(const kind of ['standing','candidate'] as const)it(`never upgrades a historical ${kind} binding into manual queue, claim or begin authority`,async()=>{
 const p=await approved();await historical(p,kind);
 const action={postId:p.postId,expectedRevision:1};
 expect((await call(p.grant.accessToken,'/social/delivery/queue')).body).not.toMatchObject({items:expect.arrayContaining([expect.objectContaining({postId:p.postId})])});
 expect((await call(p.grant.accessToken,'/social/delivery/claim',command(action))).body).toMatchObject({status:'refused',reason:'recurring_posting_removed'});
 const claimId=randomUUID();
 await f.db.query("UPDATE social_deliveries SET state='preparing',claim_id=$3,device_id=$4,claim_expires_at=now()+interval '5 minutes' WHERE workspace_id=$1 AND id=$2",[f.alpha.workspaceId,p.deliveryId,claimId,p.grant.deviceId]);
 const before=(await f.db.query('SELECT * FROM social_deliveries WHERE workspace_id=$1 AND id=$2',[f.alpha.workspaceId,p.deliveryId])).rows;
 const begin=await call(p.grant.accessToken,'/social/delivery/begin',command({claimId,approvalId:p.approvalId,fingerprint:p.fingerprint}));
 expect(begin.status).toBe(409);expect(begin.body).toMatchObject({reason:'recurring_posting_removed'});
 expect((await f.db.query('SELECT * FROM social_deliveries WHERE workspace_id=$1 AND id=$2',[f.alpha.workspaceId,p.deliveryId])).rows).toEqual(before);
 expect((await f.db.query('SELECT 1 FROM linkedin_recurring_slots WHERE workspace_id=$1 AND post_id=$2',[f.alpha.workspaceId,p.postId])).rows).toHaveLength(1);
 // Historical bindings fence only their exact revision, not a new human edit.
 expect((await call(p.grant.accessToken,'/social/posts/cancel',command(action))).status).toBe(200);
 const edited=await call(p.grant.accessToken,'/social/posts/save',command({postId:p.postId,expectedRevision:1,accountId:p.accountId,text:'New explicit manual revision',images:[],publishAt:new Date(Date.now()+86400_000).toISOString(),zone:'America/New_York'}));
 expect(edited.status).toBe(200);
 expect((await call(p.grant.accessToken,'/social/posts/approve',command({postId:p.postId,expectedRevision:2}))).status).toBe(200);
 expect((await call(p.grant.accessToken,'/social/delivery/claim',command({postId:p.postId,expectedRevision:2}))).status).toBe(200);
});
for(const kind of ['standing','candidate'] as const)it(`refuses same-revision manual handoff after a historical ${kind} delivery is held`,async()=>{
 const p=await approved();await historical(p,kind);
 const action={postId:p.postId,expectedRevision:1};
 expect((await call(p.grant.accessToken,'/social/delivery/claim',command(action))).body).toMatchObject({reason:'recurring_posting_removed'});
 expect((await call(p.grant.accessToken,'/social/delivery/hold',command({...action,reason:'adapter_unavailable'}))).status).toBe(200);
 expect((await f.db.query('SELECT state FROM social_deliveries WHERE workspace_id=$1 AND id=$2',[f.alpha.workspaceId,p.deliveryId])).rows).toEqual([{state:'failed'}]);
 const ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'user',userId:f.alpha.admin.userId,role:'admin'}),f.db);
 const {previewSocialManualHandoff}=await import('@fss/domain/social/manualHandoff.ts');
 expect(await withTransaction(f.db,()=>previewSocialManualHandoff(ctx,action))).toEqual({ok:false,reason:'recurring_posting_removed'});
 expect((await call(p.grant.accessToken,'/social/manual-handoff/read',action)).body).toMatchObject({error:'recurring_posting_removed'});
 expect((await call(p.grant.accessToken,'/social/manual-handoff/confirm',command({...action,fingerprint:'0'.repeat(64),reviewedDestination:true}))).body).toMatchObject({reason:'recurring_posting_removed'});
 expect((await f.db.query('SELECT 1 FROM social_manual_handoff_approvals WHERE workspace_id=$1 AND post_id=$2',[f.alpha.workspaceId,p.postId])).rows).toHaveLength(0);
 const edited=await call(p.grant.accessToken,'/social/posts/save',command({...action,accountId:p.accountId,text:'Explicit new unbound human revision',images:[],publishAt:new Date(Date.now()+86400_000).toISOString(),zone:'America/New_York'}));
 expect(edited.status).toBe(200);
 const next={postId:p.postId,expectedRevision:2};
 const preview=await call(p.grant.accessToken,'/social/manual-handoff/read',next);expect(preview.status).toBe(200);
 const fingerprint=z.object({view:z.object({fingerprint:z.string()})}).parse(preview.body).view.fingerprint;
 expect((await call(p.grant.accessToken,'/social/manual-handoff/confirm',command({...next,fingerprint,reviewedDestination:true}))).status).toBe(200);
 expect((await call(p.grant.accessToken,'/social/manual-handoff/read',next)).body).toMatchObject({view:{state:'manual_needed'}});
});
it('preserves installed manual submission parsing, and historical uncertainty remains inspect/cancel only',async()=>{
 const p=await approved();
 await f.db.query('UPDATE sessions SET client_version=$3 WHERE workspace_id=$1 AND device_id=$2',[f.alpha.workspaceId,p.grant.deviceId,'1.0.51']);
 const action={postId:p.postId,expectedRevision:1};
 const claimed=await call(p.grant.accessToken,'/social/delivery/claim',command(action,'1.0.51'));expect(claimed.status).toBe(200);
 const claim=z.object({result:z.object({claimId:z.uuid(),approvalId:z.uuid(),fingerprint:z.string()})}).parse(claimed.body).result;
 const begun=await call(p.grant.accessToken,'/social/delivery/begin',command(claim,'1.0.51'));expect(begun.status).toBe(200);
 // Actual installed 1.0.51 pins d49dda37: its deliveryApi parser is strict and
 // accepts only submissionId, with no posting-policy field at all.
 const marker=z.strictObject({status:z.literal('accepted'),replayed:z.boolean(),result:z.strictObject({submissionId:z.uuid()})}).parse(begun.body).result;
 expect(marker).not.toHaveProperty('postingPolicyBound');
 await historical(p,'standing');
 const queue=await call(p.grant.accessToken,'/social/delivery/queue');expect(queue.body).toMatchObject({items:expect.arrayContaining([expect.objectContaining({postId:p.postId,action:'inspect',submissionId:marker.submissionId})])});
 expect((await call(p.grant.accessToken,'/social/delivery/claim',command(action,'1.0.51'))).body).toMatchObject({reason:'inspect_existing_submission'});
 expect((await call(p.grant.accessToken,'/social/posts/cancel',command(action,'1.0.51'))).status).toBe(200);
 expect((await call(p.grant.accessToken,'/social/delivery/queue')).body).toMatchObject({items:expect.arrayContaining([expect.objectContaining({postId:p.postId,action:'cancel',submissionId:marker.submissionId})])});
 const other=await issueSessionFor(f,f.beta,f.beta.admin);expect((await call(other.accessToken,'/social/delivery/queue')).body).toEqual({items:[]});
 expect((await f.db.query<{submission_id:string}>('SELECT submission_id FROM social_deliveries WHERE workspace_id=$1 AND id=$2',[f.alpha.workspaceId,p.deliveryId])).rows[0]?.submission_id).toBe(marker.submissionId);
});
it('stops historical queued drafting before token counting, provider dispatch or reservations, preserving recorded rows',async()=>{
 const p=await approved(),old=await historical(p,'standing');
 const countInputTokens=vi.fn(async()=>100),generate=vi.fn(async()=>({raw:'{}',costCents:1,costEstimated:false}));
 const worker=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'system',component:'worker'}),f.db);
 await runSocialDraft(worker,old.draftId,{providerKey:'aws_bedrock.social_draft',countInputTokens,generate});
 expect(countInputTokens).not.toHaveBeenCalled();expect(generate).not.toHaveBeenCalled();
 expect((await f.db.query('SELECT state,reason,paid_attempts FROM social_draft_requests WHERE workspace_id=$1 AND id=$2',[f.alpha.workspaceId,old.draftId])).rows).toEqual([{state:'review',reason:'recurring_posting_removed',paid_attempts:0}]);
 expect((await f.db.query('SELECT 1 FROM provider_reservations WHERE workspace_id=$1 AND subject_id=$2',[f.alpha.workspaceId,old.draftId])).rows).toHaveLength(0);
 expect((await f.db.query('SELECT state FROM linkedin_recurring_slots WHERE workspace_id=$1 AND id=$2',[f.alpha.workspaceId,old.slotId])).rows).toEqual([{state:'queued'}]);
});
it('reaches later manual work beyond a full page of permanently held historical bindings',async()=>{
 for(let index=0;index<27;index++)await historical(await approved(),'candidate');
 const manual=await approved();
 const queue=await call(manual.grant.accessToken,'/social/delivery/queue');
 expect(queue.status).toBe(200);
 expect(queue.body).toMatchObject({items:expect.arrayContaining([expect.objectContaining({postId:manual.postId,action:'submit'})])});
 const other=await issueSessionFor(f,f.alpha,f.alpha.salesperson);
 expect((await call(other.accessToken,'/social/delivery/queue')).body).toEqual({items:[]});
});
