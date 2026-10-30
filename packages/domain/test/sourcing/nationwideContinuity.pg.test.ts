import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {targetingProposalSchema,type TargetingQuery} from '@fss/contracts';
import {repositoryContext} from '../../db/workspaceScope.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {automaticResearchProof} from '../../sourcing/automaticResearchProof.ts';
import {advanceAutomaticResearchFirm,readAutomaticResearchFirm} from '../../sourcing/automaticResearch.ts';
import {readTargetingPolicy,saveTargetingProposal,applyTargetingProposal} from '../../sourcing/targetingProposals.ts';
import {currentUSPreparedSupplyPgFixture} from './currentUSPreparedSupplyPgFixture.ts';
let f:Awaited<ReturnType<typeof currentUSPreparedSupplyPgFixture>>;
beforeAll(async()=>{f=await currentUSPreparedSupplyPgFixture();});
afterAll(async()=>f?.drop());
async function proposal(changes:TargetingQuery[]=[]){
 const policy=await readTargetingPolicy(f.admin);
 const result=await withTransaction(f.runtime,()=>saveTargetingProposal(f.admin,targetingProposalSchema.parse({basePolicyVersion:policy.version,queryChanges:changes,
  rankOrder:[...policy.rankOrder].reverse(),evidenceIds:[],rationale:'Fictional unchanged-query continuity and epoch test.'})));
 if(!result.ok)throw Error(result.reason);return result.value;
}
async function approve(input:{id:string;revision:number},db=f.runtime){
 const admin=repositoryContext(f.admin.scope,db);
 const result=await withTransaction(db,()=>applyTargetingProposal(admin,{id:input.id,expectedRevision:input.revision}));
 if(!result.ok)throw Error(result.reason);return result.value.policyVersion;
}
async function published(candidateId:string){
 return (await f.runtime.query<{id:string;evidence_fingerprint:string;revision:number}>('SELECT id,evidence_fingerprint,revision FROM sourcing_automatic_research_firms WHERE workspace_id=$1 AND candidate_id=$2',[f.seed.alpha.workspaceId,candidateId])).rows[0]??null;
}
async function waiting(pid:number){
 for(let n=0;n<200;n++){
  if((await f.database.session.query<{waiting:boolean}>("SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.waiting)return;
  await new Promise(resolve=>setTimeout(resolve,5));
 }
 throw Error('Expected actual PostgreSQL lock wait');
}
function paused(db:SessionQueryable,key:string,match:(sql:string)=>boolean):SessionQueryable{
 let used=false;
 return {query:async(sql,values)=>{
  if(!used&&match(sql)){used=true;await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[key]);await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}
  return db.query(sql,values);
 }};
}
it('app_runtime preserves an acquired fingerprint and publishes/reads after additive/ranking approval without rewriting prior provenance',async()=>{
 const item=await f.prepared(),before=await automaticResearchProof(f.worker,item.candidateId);expect(before).not.toBeNull();
 const change={id:`additional-${randomUUID()}`,query:'Portland Maine residential property management',locality:'Portland',region:'ME' as const};
 const version=await approve(await proposal([change])),after=await automaticResearchProof(f.worker,item.candidateId);
 expect(after?.fingerprint).toBe(before?.fingerprint);expect(after?.source).toEqual(before?.source);expect(after?.targetingVersion).toBe(version);
 await withTransaction(f.runtime,()=>advanceAutomaticResearchFirm(f.worker,{runId:item.runId},'prepare_before_legacy'));
 const row=await published(item.candidateId);expect(row?.evidence_fingerprint).toBe(before?.fingerprint);if(!row)throw Error('Publication missing');
 expect(await readAutomaticResearchFirm(f.admin,row.id)).toMatchObject({target:{evidenceFingerprint:before?.fingerprint},channelAuthority:'not_granted'});
 expect((await f.runtime.query('SELECT policy_version FROM sourcing_discovery_attempts WHERE workspace_id=$1 AND id=$2',[f.seed.alpha.workspaceId,item.attempt])).rows[0]?.['policy_version']).toBe(before?.targetingVersion);
});
it('a publication holds the policy epoch through a real wait; a concurrent normal apply commits only afterward',async()=>{
 const item=await f.prepared(),draft=await proposal(),other=await f.database.appRuntimeSession(),blocker=await f.database.appRuntimeSession(),key=`nationwide-publication-${randomUUID()}`;
 const pid=(await f.runtime.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
 const otherPid=(await other.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
 await blocker.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[key]);
 const worker=repositoryContext(f.worker.scope,paused(f.runtime,key,sql=>sql.startsWith('SELECT id FROM sourcing_candidates')&&sql.endsWith('FOR UPDATE')));
 const publishing=withTransaction(f.runtime,()=>advanceAutomaticResearchFirm(worker,{runId:item.runId},'prepare_before_legacy'));
 let applying:Promise<string>|undefined;
 try{await waiting(pid);applying=approve(draft,other);await waiting(otherPid);}
 finally{await blocker.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}
 await publishing;await applying;expect(await published(item.candidateId)).not.toBeNull();
});
it('a current read refuses a committed targeting epoch change across an actual wait even with equal evidence fingerprints',async()=>{
 const item=await f.prepared();await withTransaction(f.runtime,()=>advanceAutomaticResearchFirm(f.worker,{runId:item.runId},'prepare_before_legacy'));
 const row=await published(item.candidateId);if(!row)throw Error('Publication missing');
 const before=await automaticResearchProof(f.worker,item.candidateId),draft=await proposal(),other=await f.database.appRuntimeSession(),key=`nationwide-read-${randomUUID()}`;
 await other.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[key]);
 const pid=(await f.runtime.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
 const admin=repositoryContext(f.admin.scope,paused(f.runtime,key,sql=>sql.includes('SELECT id, name, website FROM firms')));
 const reading=readAutomaticResearchFirm(admin,row.id);
 try{await waiting(pid);await approve(draft,other);}finally{await other.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}
 expect(await reading).toBeNull();expect((await automaticResearchProof(f.worker,item.candidateId))?.fingerprint).toBe(before?.fingerprint);
 expect(await readAutomaticResearchFirm(f.admin,row.id)).not.toBeNull();
});
it('a changed query tuple refuses current proof, and re-adding it cannot revive an erased source association',async()=>{
 const item=await f.prepared(),before=await automaticResearchProof(f.worker,item.candidateId);if(!before)throw Error('Proof missing');
 const acquired=(await f.runtime.query<{query_id:string}>('SELECT query_id FROM sourcing_discovery_attempts WHERE workspace_id=$1 AND id=$2',[f.seed.alpha.workspaceId,item.attempt])).rows[0];
 const policy=await readTargetingPolicy(f.admin),query=policy.queries.find(q=>q.id===acquired?.query_id);if(!query)throw Error('Acquired query missing');
 await approve(await proposal([{...query,locality:'Different fictional city'}]));expect(await automaticResearchProof(f.worker,item.candidateId)).toBeNull();
 await f.runtime.query('UPDATE sourcing_discovery_hits SET candidate_id=NULL WHERE workspace_id=$1 AND candidate_id=$2',[f.seed.alpha.workspaceId,item.candidateId]);
 await approve(await proposal([query]));expect(await automaticResearchProof(f.worker,item.candidateId)).toBeNull();
 await withTransaction(f.runtime,()=>advanceAutomaticResearchFirm(f.worker,{runId:item.runId},'prepare_before_legacy'));expect(await published(item.candidateId)).toBeNull();
});
