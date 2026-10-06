import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {requestSocialDrafts,readSocialDraftRequest,expireSocialDraftRequests} from '../../social/drafts.ts';
let db:TestDatabase,seed:TwoWorkspaces;
const ctx=(beta=false)=>{const s=beta?seed.beta:seed.alpha;return repositoryContext(workspaceScope(s.workspaceId,{kind:'user',userId:s.admin.userId,role:'admin'}),db.session);};
const worker=()=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'system',component:'worker'}),db.session);
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);});afterAll(async()=>db.drop());
async function input(){const id=randomUUID();await db.session.query('INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload) VALUES($1,$2,$3,$4::jsonb)',[seed.alpha.workspaceId,id,id.replaceAll('-','').repeat(2),JSON.stringify({brief:'After-hours maintenance for PRIVATE CUSTOMER at 51 Oak Street.'})]);return {sourceRefs:[{kind:'public' as const,id,revision:1}],factBlocks:[]};}
it('persists references and hashes, deduplicates active evidence, and remains owner scoped',async()=>{
 const request=await input();const a=await withTransaction(db.session,()=>requestSocialDrafts(ctx(),request));expect(a.ok).toBe(true);if(!a.ok)throw new Error(a.reason);
 const b=await withTransaction(db.session,()=>requestSocialDrafts(ctx(),request));expect(b).toEqual(a);
 const row=await readSocialDraftRequest(ctx(),a.value.requestId);expect(row?.state).toBe('queued');expect(row?.paid_attempts).toBe(0);
 expect(JSON.stringify(row)).not.toContain('PRIVATE CUSTOMER');expect(JSON.stringify(row)).not.toContain('Oak Street');
 expect(await readSocialDraftRequest(ctx(true),a.value.requestId)).toBeNull();
 const sameWorkspace=repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.salesperson.userId,role:'salesperson'}),db.session);
 expect(await readSocialDraftRequest(sameWorkspace,a.value.requestId)).toBeNull();
 expect((await requestSocialDrafts(worker(),request)).ok).toBe(false);
 expect((await db.session.query('SELECT * FROM social_posts WHERE workspace_id=$1',[seed.alpha.workspaceId])).rows).toHaveLength(0);
});
it('expires queued and crashed calling requests without discarding spend or returning them to queued',async()=>{
 const a=await withTransaction(db.session,async()=>requestSocialDrafts(ctx(),await input()));if(!a.ok)throw new Error(a.reason);
 await db.session.query("UPDATE social_draft_requests SET state='calling',paid_attempts=1,created_at=now()-interval '31 minutes',deadline_at=now()-interval '1 minute' WHERE workspace_id=$1 AND id=$2",[seed.alpha.workspaceId,a.value.requestId]);
 expect(await expireSocialDraftRequests(worker())).toBe(1);
 const row=await readSocialDraftRequest(ctx(),a.value.requestId);expect(row?.state).toBe('expired');expect(row?.paid_attempts).toBe(1);
 expect(await expireSocialDraftRequests(worker())).toBe(0);
});
it('commits a budgeted claim before generation and only accepts current evidence',async()=>{
 const {runSocialDraft}=await import('../../social/draftRun.ts');
 const request=await input();const a=await withTransaction(db.session,()=>requestSocialDrafts(ctx(),request));if(!a.ok)throw new Error(a.reason);
 let calls=0;
 await runSocialDraft(worker(),a.value.requestId,{providerKey:'aws_bedrock.social_draft',countInputTokens:async()=>100,generate:async()=>{
  calls++;const reservations=(await db.session.query("SELECT state FROM provider_reservations WHERE workspace_id=$1 AND subject_id=$2",[seed.alpha.workspaceId,a.value.requestId])).rows;
  expect(reservations).toEqual([{state:'calling'}]);
  return {raw:JSON.stringify({concepts:[{theme:'after_hours',factRefs:[],variants:['linkedin','facebook','x'].map(platform=>({platform,text:'Who handles maintenance calls after hours?'}))}]}),costCents:1,costEstimated:false};
 }});
 expect(calls).toBe(1);expect((await readSocialDraftRequest(ctx(),a.value.requestId))?.state).toBe('ready');
 await runSocialDraft(worker(),a.value.requestId,{providerKey:'aws_bedrock.social_draft',countInputTokens:async()=>100,generate:async()=>{throw new Error('must not repeat');}});
 const b=await withTransaction(db.session,()=>requestSocialDrafts(ctx(),request));if(!b.ok)throw new Error(b.reason);
 await runSocialDraft(worker(),b.value.requestId,{providerKey:'aws_bedrock.social_draft',countInputTokens:async()=>100,generate:async()=>{
  await db.session.query('UPDATE sourcing_candidates SET revision=revision+1 WHERE workspace_id=$1 AND id=$2',[seed.alpha.workspaceId,request.sourceRefs[0]!.id]);
  return {raw:'{}',costCents:1,costEstimated:false};
 }});
 expect((await readSocialDraftRequest(ctx(),b.value.requestId))?.state).toBe('review');
 expect((await db.session.query("SELECT state FROM provider_reservations WHERE workspace_id=$1 AND subject_id=$2",[seed.alpha.workspaceId,b.value.requestId])).rows).toEqual([{state:'settled'}]);
});
it('caps unsuccessful generation at two paid attempts and respects the credit budget',async()=>{
 const {runSocialDraft}=await import('../../social/draftRun.ts');const {updateResearchSettings}=await import('../../research/settings.ts');
 const a=await withTransaction(db.session,async()=>requestSocialDrafts(ctx(),await input()));if(!a.ok)throw new Error(a.reason);
 let calls=0;const port={providerKey:'aws_bedrock.social_draft' as const,countInputTokens:async()=>100,generate:async()=>{calls++;throw new Error('provider unavailable');}};
 await withTransaction(db.session,()=>updateResearchSettings(ctx(),{dailyCostCeilingCents:0}));
 await runSocialDraft(worker(),a.value.requestId,port);expect(calls).toBe(0);
 await withTransaction(db.session,()=>updateResearchSettings(ctx(),{dailyCostCeilingCents:50}));
 await runSocialDraft(worker(),a.value.requestId,port);await runSocialDraft(worker(),a.value.requestId,port);await runSocialDraft(worker(),a.value.requestId,port);
 expect(calls).toBe(2);const row=await readSocialDraftRequest(ctx(),a.value.requestId);expect(row?.state).toBe('review');expect(row?.paid_attempts).toBe(2);
 expect((await db.session.query("SELECT state FROM provider_reservations WHERE workspace_id=$1 AND subject_id=$2",[seed.alpha.workspaceId,a.value.requestId])).rows).toEqual([{state:'estimated'},{state:'estimated'}]);
});
it('settles a lost calling reservation conservatively when its request expires',async()=>{
 const {reserveAttempt,markCalling}=await import('../../research/reservations.ts');
 const a=await withTransaction(db.session,async()=>requestSocialDrafts(ctx(),await input()));if(!a.ok)throw new Error(a.reason);
 await withTransaction(db.session,async()=>{const r=await reserveAttempt(worker(),{subjectKind:'social_draft',subjectId:a.value.requestId,attempt:1,providerKey:'aws_bedrock.social_draft',at:new Date().toISOString(),businessTimeZone:'Etc/UTC',cents:3,modelName:'claude-haiku-4-5',maxInputTokens:100,maxOutputTokens:4096});await markCalling(worker(),r.id);});
 await db.session.query("UPDATE social_draft_requests SET state='calling',paid_attempts=1,created_at=now()-interval '31 minutes',deadline_at=now()-interval '1 minute' WHERE workspace_id=$1 AND id=$2",[seed.alpha.workspaceId,a.value.requestId]);
 await withTransaction(db.session,()=>expireSocialDraftRequests(worker()));
 expect((await db.session.query('SELECT state,settled_cents FROM provider_reservations WHERE workspace_id=$1 AND subject_id=$2',[seed.alpha.workspaceId,a.value.requestId])).rows).toEqual([{state:'estimated',settled_cents:3}]);
});
it('lists only bounded current source choices, approved facts and the owners requests',async()=>{
 const {readSocialDraftWorkspace}=await import('../../social/draftWorkspace.ts');
 const request=await input();const a=await withTransaction(db.session,()=>requestSocialDrafts(ctx(),request));if(!a.ok)throw new Error(a.reason);
 const view=await readSocialDraftWorkspace(ctx());
 expect(view.sources.some(s=>s.id===request.sourceRefs[0]!.id)).toBe(true);expect(view.requests.some(r=>r.id===a.value.requestId)).toBe(true);
 expect(JSON.stringify(view)).not.toContain('PRIVATE CUSTOMER');expect(JSON.stringify(view)).not.toContain('Oak Street');
 expect((await readSocialDraftWorkspace(ctx(true))).sources).toEqual([]);
 await db.session.query("UPDATE sourcing_candidates SET status='dismissed' WHERE workspace_id=$1 AND id=$2",[seed.alpha.workspaceId,request.sourceRefs[0]!.id]);
 expect((await readSocialDraftWorkspace(ctx())).sources.some(s=>s.id===request.sourceRefs[0]!.id)).toBe(false);
});
