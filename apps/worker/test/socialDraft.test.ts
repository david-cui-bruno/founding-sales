import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createTestDatabase} from '@fss/domain/db/testing/testDatabase.ts';
import {seedTwoWorkspaces} from '@fss/domain/test/db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {requestSocialDrafts} from '@fss/domain/social/drafts.ts';
import {socialDraftSource,socialDraftHandler} from '../src/social/draftJobs.ts';
it('queues only explicit live requests and expires crashed work even with generation disabled',async()=>{
 const db=await createTestDatabase();try{
 const seed=await seedTwoWorkspaces(db.session),w=seed.alpha.workspaceId;
 const ctx=repositoryContext(workspaceScope(w,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),db.session);
 const at=new Date().toISOString();expect(await withTransaction(db.session,()=>socialDraftSource(true).find(db.session,at))).toEqual([]);
 const id=randomUUID();await db.session.query('INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload) VALUES($1,$2,$3,$4::jsonb)',[w,id,'c'.repeat(64),JSON.stringify({brief:'After-hours maintenance coordination'})]);
 const r=await withTransaction(db.session,()=>requestSocialDrafts(ctx,{sourceRefs:[{kind:'public',id,revision:1}],factBlocks:[]}));if(!r.ok)throw new Error(r.reason);
 expect(await withTransaction(db.session,()=>socialDraftSource(false).find(db.session,at))).toEqual([]);
 const jobs=await withTransaction(db.session,()=>socialDraftSource(true).find(db.session,at));expect(jobs).toHaveLength(1);expect(jobs[0]).toMatchObject({workspaceId:w,kind:'social.draft',payload:{requestId:r.value.requestId},maxAttempts:1});
 expect(await withTransaction(db.session,()=>socialDraftSource(true).find(db.session,at))).toEqual(jobs);
 await db.session.query("UPDATE social_draft_requests SET state='calling',paid_attempts=1,created_at=now()-interval '31 minutes',deadline_at=now()-interval '1 minute' WHERE workspace_id=$1 AND id=$2",[w,r.value.requestId]);
 expect(await withTransaction(db.session,()=>socialDraftSource(false).find(db.session,at))).toEqual([]);
 expect((await db.session.query('SELECT state FROM social_draft_requests WHERE workspace_id=$1 AND id=$2',[w,r.value.requestId])).rows).toEqual([{state:'expired'}]);
 expect(socialDraftHandler(null)).toMatchObject({kind:'social.draft',protection:'outbound_fence',maxAttempts:1});
 }finally{await db.drop();}
});
it('materializes an opted-in weekly batch even when there are no existing draft requests',async()=>{
 const {saveSocialWeekly}=await import('@fss/domain/social/weekly.ts');const db=await createTestDatabase();try{
 const seed=await seedTwoWorkspaces(db.session),w=seed.alpha.workspaceId,ctx=repositoryContext(workspaceScope(w,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),db.session);
 await db.session.query('INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload) VALUES($1,$2,$3,$4::jsonb)',[w,randomUUID(),'d'.repeat(64),JSON.stringify({brief:'After-hours maintenance support'})]);
 await withTransaction(db.session,()=>saveSocialWeekly(ctx,{enabled:true,expectedRevision:0}));
 expect(await withTransaction(db.session,()=>socialDraftSource(false).find(db.session,new Date().toISOString()))).toEqual([]);
 expect((await db.session.query('SELECT count(*)::integer AS n FROM social_draft_requests')).rows[0]?.['n']).toBe(0);
 const jobs=await withTransaction(db.session,()=>socialDraftSource(true).find(db.session,new Date().toISOString()));expect(jobs).toHaveLength(1);
 }finally{await db.drop();}
});
