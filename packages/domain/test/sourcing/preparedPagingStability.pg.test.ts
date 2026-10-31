import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {listPreparedProspects} from '../../sourcing/preparedProspects.ts';
import {seedPreparedProspect} from './preparedProspectsPgFixture.ts';

let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable;
const ctx=()=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),runtime);
const list=(offset=0,viewRevision?:string)=>withTransaction(runtime,()=>listPreparedProspects(ctx(),{offset,...(viewRevision?{viewRevision}:{})}));
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
beforeEach(async()=>{await runtime.query('DELETE FROM sourcing_candidates');for(let i=0;i<51;i++)await seedPreparedProspect(ctx(),i);});
afterAll(async()=>db?.drop());

async function pages(){
 const first=await list();if(!first.ok)throw Error(first.reason);
 const second=await list(50,first.value.viewRevision);if(!second.ok)throw Error(second.reason);
 expect(second.value.prospects).toHaveLength(1);const offPage=second.value.prospects[0]!;
 expect(first.value.prospects.some(p=>p.target.candidateId===offPage.target.candidateId)).toBe(false);
 return {first:first.value,second:second.value,offPage};
}

it('keeps prepared continuation stable after only normal admission-check timestamps change',async()=>{
 expect((await runtime.query('SELECT current_user')).rows).toEqual([{current_user:'app_runtime'}]);
 const first=await list();if(!first.ok)throw Error(first.reason);
 expect(first.value.prospects).toHaveLength(50);expect(first.value.hasMore).toBe(true);
 const again=await list();if(!again.ok)throw Error(again.reason);
 expect(again.value.viewRevision).toBe(first.value.viewRevision);
 expect(again.value.prospects.map(p=>p.target)).toEqual(first.value.prospects.map(p=>p.target));
 const before=await list(50,first.value.viewRevision);if(!before.ok)throw Error(before.reason);expect(before.value.prospects).toHaveLength(1);
 const content=async()=>(await runtime.query("SELECT id,to_jsonb(r)-'admission_checked_at' AS content FROM sourcing_qualification_runs r ORDER BY id")).rows;
 const originals=await content();
 await runtime.query('UPDATE sourcing_qualification_runs SET admission_checked_at=clock_timestamp()');
 expect(await content()).toEqual(originals);
 const after=await list(50,first.value.viewRevision);expect(after).toMatchObject({ok:true});if(!after.ok)throw Error(after.reason);
 expect(after.value.viewRevision).toBe(first.value.viewRevision);expect(after.value.prospects).toEqual(before.value.prospects);
});

it.each(['original','state','additional_run_field','latest_run','candidate_context','source_loss'] as const)('invalidates continuation when an off-page %s changes',async change=>{
 const {first,offPage}=await pages(),{candidateId,runId}=offPage.target;
 if(change==='original')await runtime.query("UPDATE sourcing_qualification_runs SET observations=jsonb_set(observations,'{0,blocks,0,text}',to_jsonb('Changed original brand passage'::text)) WHERE id=$1",[runId]);
 if(change==='state')await runtime.query("UPDATE sourcing_qualification_runs SET state='review' WHERE id=$1",[runId]);
 if(change==='additional_run_field')await runtime.query("UPDATE sourcing_qualification_runs SET opening_question='How is the new retained workflow handled?' WHERE id=$1",[runId]);
 if(change==='latest_run')await runtime.query(`INSERT INTO sourcing_qualification_runs(workspace_id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name,requested_at,deadline_at)
  VALUES($1,$2,1,$3,'qualification-context-v7','qualification-v5','none',clock_timestamp()+interval '1 second',clock_timestamp()+interval '31 minutes')`,[seed.alpha.workspaceId,candidateId,createHash('sha256').update(randomUUID()).digest('hex')]);
 if(change==='candidate_context')await runtime.query("UPDATE sourcing_candidates SET payload=jsonb_set(payload,'{locality}',to_jsonb('Cambridge'::text)) WHERE id=$1",[candidateId]);
 if(change==='source_loss')await runtime.query(`UPDATE sourcing_candidates SET source_check='{"state":"unavailable","reason":"source_not_permitted"}' WHERE id=$1`,[candidateId]);
 expect(await list(50,first.viewRevision)).toMatchObject({ok:false,reason:'view_changed'});
 const refreshed=await list();if(!refreshed.ok)throw Error(refreshed.reason);expect(refreshed.value.viewRevision).not.toBe(first.viewRevision);
});

it('invalidates global continuation when an off-page capture manifest is erased without changing originals',async()=>{
 const initial=await pages(),target=initial.offPage.target;
 const original=(await runtime.query<{observations:{id:string;url:string;contentHash:string;relevantTextHash:string;retrievedAt:string}[]}>('SELECT observations FROM sourcing_qualification_runs WHERE id=$1',[target.runId])).rows[0]!.observations;
 const website=initial.offPage.website!;const sourceUrl=website+'services',url=sourceUrl+'/';
 await runtime.query("UPDATE sourcing_candidates SET payload=jsonb_set(payload,'{sourceUrl}',to_jsonb($2::text)) WHERE id=$1",[target.candidateId,sourceUrl]);
 const runId=randomUUID(),observations=original.map(page=>({...page,url})),page=observations[0]!;
 await runtime.query(`INSERT INTO sourcing_qualification_runs(workspace_id,id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name,capture_policy_version,requested_at,deadline_at)
  VALUES($1,$2,$3,1,$4,'qualification-context-v7','qualification-v5','none','prepared-source-association-v1',clock_timestamp()+interval '1 second',clock_timestamp()+interval '31 minutes')`,[seed.alpha.workspaceId,runId,target.candidateId,createHash('sha256').update(runId).digest('hex')]);
 const manifest={version:'prepared-source-association-v1',candidateId:target.candidateId,candidateRevision:1,sourceUrl,pages:[{observationId:page.id,url,contentHash:page.contentHash,relevantTextHash:page.relevantTextHash,retrievedAt:page.retrievedAt,redirectUrls:[sourceUrl,url]}]};
 await runtime.query("UPDATE sourcing_qualification_runs SET state='unavailable',reason='invalid_evidence',observations=$2::jsonb,prepared_capture=$3::jsonb WHERE id=$1",[runId,JSON.stringify(observations),JSON.stringify(manifest)]);
 const {first,offPage}=await pages();expect(offPage.target.runId).toBe(runId);expect(offPage.state).toBe('prepared');
 await runtime.query('UPDATE sourcing_qualification_runs SET prepared_capture=NULL WHERE id=$1',[runId]);
 expect((await runtime.query('SELECT observations FROM sourcing_qualification_runs WHERE id=$1',[runId])).rows).toEqual([{observations}]);
 expect(await list(50,first.viewRevision)).toMatchObject({ok:false,reason:'view_changed'});
});
