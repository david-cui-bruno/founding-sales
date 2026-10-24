import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {readSocialDraftSources} from '../../social/draftSources.ts';
import {readSocialDraftRequest} from '../../social/drafts.ts';
import {readSocialDraftWorkspace} from '../../social/draftWorkspace.ts';
let db:TestDatabase,seed:TwoWorkspaces;
const ctx=()=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),db.session);
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);});afterAll(async()=>db.drop());
async function retained(){
 const sourceId=randomUUID();await db.session.query('INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload) VALUES($1,$2,$3,$4::jsonb)',[seed.alpha.workspaceId,sourceId,sourceId.replaceAll('-','').repeat(2),JSON.stringify({brief:'After-hours maintenance support.'})]);
 const selection={sourceRefs:[{kind:'public' as const,id:sourceId,revision:1}],factBlocks:[]};
 const prepared=await withTransaction(db.session,()=>readSocialDraftSources(ctx(),selection));if(!prepared.ok)throw Error(prepared.reason);
 const concepts=[{theme:'after_hours',factRefs:[],variants:[{platform:'linkedin',text:'Controlled retained legacy suggestion.'}]}];
 const row=(await db.session.query<{id:string}>("INSERT INTO social_draft_requests(workspace_id,owner_user_id,source_selection,source_hash,prompt_version,model_name,state,concepts) VALUES($1,$2,$3::jsonb,$4,'social-themes-v1','claude-haiku-4-5','ready',$5::jsonb) RETURNING id",[seed.alpha.workspaceId,seed.alpha.admin.userId,JSON.stringify(selection),prepared.value.hash,JSON.stringify(concepts)])).rows[0]!;
 return {id:row.id,sourceId,concepts};
}
it.each(['revision','delete','dismiss'] as const)('withholds legacy source-only ready text after %s without a durable write',async change=>{
 const r=await retained();expect((await withTransaction(db.session,()=>readSocialDraftRequest(ctx(),r.id)))?.concepts).toEqual(r.concepts);
 if(change==='revision')await db.session.query('UPDATE sourcing_candidates SET revision=2 WHERE id=$1',[r.sourceId]);
 if(change==='delete')await db.session.query('DELETE FROM sourcing_candidates WHERE id=$1',[r.sourceId]);
 if(change==='dismiss')await db.session.query("UPDATE sourcing_candidates SET status='dismissed' WHERE id=$1",[r.sourceId]);
 const answer=await withTransaction(db.session,()=>readSocialDraftRequest(ctx(),r.id));expect(answer).toMatchObject({state:'review',concepts:null,reason:'source_changed_or_unavailable'});
 const workspace=await withTransaction(db.session,()=>readSocialDraftWorkspace(ctx()));expect(workspace.requests.find(row=>row.id===r.id)).toMatchObject({state:'review',concepts:null});
 expect((await db.session.query('SELECT state,concepts FROM social_draft_requests WHERE id=$1',[r.id])).rows[0]).toEqual({state:'ready',concepts:r.concepts});
});
it('returns no expired or non-ready retained prose, preserving durable request state',async()=>{
 const r=await retained();await db.session.query("UPDATE social_draft_requests SET created_at=now()-interval '31 minutes',deadline_at=now()-interval '1 minute' WHERE id=$1",[r.id]);
 expect(await withTransaction(db.session,()=>readSocialDraftRequest(ctx(),r.id))).toMatchObject({state:'expired',concepts:null});
 await db.session.query("UPDATE social_draft_requests SET state='review' WHERE id=$1",[r.id]);expect(await withTransaction(db.session,()=>readSocialDraftRequest(ctx(),r.id))).toMatchObject({state:'review',concepts:null});
});
it('refuses foreign owner and bounds the workspace at 20 requests and 20 public sources',async()=>{
 for(let i=0;i<22;i++)await retained();const workspace=await withTransaction(db.session,()=>readSocialDraftWorkspace(ctx()));expect(workspace.requests).toHaveLength(20);expect(workspace.sources.filter(source=>source.kind==='public')).toHaveLength(20);
 const foreign=repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.salesperson.userId,role:'salesperson'}),db.session);expect(await readSocialDraftRequest(foreign,workspace.requests[0]!.id)).toBeNull();
});
