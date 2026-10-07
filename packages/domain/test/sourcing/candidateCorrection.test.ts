import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {saveCandidate,listCandidates} from '../../sourcing/candidates.ts';
import {correctCandidateName} from '../../sourcing/candidateCorrection.ts';
import {requestQualification,finishQualification,readQualification} from '../../sourcing/qualificationStore.ts';
let db:TestDatabase,seeded:TwoWorkspaces;
const draft={firmName:'Dallas Property Management | Example PM',website:'https://example.test/',locality:'Dallas',region:'TX' as const,signal:'fit_only' as const,evidence:'Need unknown',sourceUrl:'https://example.test/about',observedOn:'2026-10-01',preparedBy:'Discovery',discoveryQuery:'Dallas managers'};
const ctx=(workspace:'alpha'|'beta'='alpha',role:'admin'|'salesperson'='admin')=>repositoryContext(workspaceScope(seeded[workspace].workspaceId,{kind:'user',userId:seeded[workspace][role].userId,role}),db.session);
const tx=<T>(fn:()=>Promise<T>)=>withTransaction(db.session,fn);
async function fixture(patch:Record<string,unknown>={}){
 const saved=await tx(()=>saveCandidate(ctx(),draft));if(!saved.ok)throw Error(saved.reason);
 const request=await tx(()=>requestQualification(ctx(),{candidateId:saved.value.id,expectedRevision:1}));if(!request.ok)throw Error(request.reason);
 const source={id:randomUUID(),url:draft.sourceUrl,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:new Date().toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[{id:'name',text:'Example PM manages residential homes in Dallas TX.'}],...patch};
 const fact={kind:'firm_identity' as const,value:'Example PM',observationId:source.id,blockId:'name'};
 expect(await tx(()=>finishQualification(ctx(),{runId:request.value.runId,observations:[source],facts:[fact],reason:null}))).toMatchObject({ok:true});
 return {id:saved.value.id,expectedRevision:1,firmName:'Example PM',qualificationRunId:request.value.runId,observationId:source.id,blockId:'name',reason:'Reviewed first-party company name; remove the SEO title.'};
}
beforeAll(async()=>{db=await createTestDatabase();seeded=await seedTwoWorkspaces(db.session);});
beforeEach(async()=>{await db.session.query('DELETE FROM sourcing_candidates');await db.session.query('DELETE FROM daily_counters');});
afterAll(async()=>{await db.drop();});
it('corrects in place, keeps attribution/evidence, invalidates old eligibility and requires fresh research',async()=>{
 const input=await fixture();
 expect(await tx(()=>correctCandidateName(ctx(),input))).toEqual({ok:true,value:{id:input.id,revision:2}});
 expect(await listCandidates(ctx(),{status:'needs_review',offset:0})).toMatchObject({value:{candidates:[{id:input.id,firmName:'Example PM',discoveryQuery:draft.discoveryQuery,evidence:draft.evidence,revision:2}]}});
 expect(await readQualification(ctx(),{candidateId:input.id})).toMatchObject({status:'unavailable',reason:'candidate_changed',facts:[{value:'Example PM'}]});
 const old=(await db.session.query('SELECT state,observations FROM sourcing_qualification_runs WHERE id=$1',[input.qualificationRunId])).rows[0];expect(old?.['state']).toBe('review');expect(old?.['observations']).toHaveLength(1);
 expect((await db.session.query("SELECT detail FROM audit_events WHERE action='sourcing.candidate_name_corrected' AND subject_id=$1",[input.id])).rows).toMatchObject([{detail:{previousName:draft.firmName,firmName:'Example PM',previousRevision:1}}]);
 const fresh=await tx(()=>requestQualification(ctx(),{candidateId:input.id,expectedRevision:2}));expect(fresh.ok&&fresh.value.runId).not.toBe(input.qualificationRunId);
 expect(await tx(()=>correctCandidateName(ctx(),input))).toMatchObject({reason:'candidate_changed'});
});
it('refuses non-admin, other workspace, stale revision and unsupported name',async()=>{
 const input=await fixture();
 expect(await tx(()=>correctCandidateName(ctx('alpha','salesperson'),input))).toMatchObject({reason:'admin_only'});
 expect(await tx(()=>correctCandidateName(ctx('beta'),input))).toMatchObject({reason:'not_found'});
 expect(await tx(()=>correctCandidateName(ctx(),{...input,expectedRevision:2}))).toMatchObject({reason:'candidate_changed'});
 expect(await tx(()=>correctCandidateName(ctx(),{...input,firmName:'Different Company'}))).toMatchObject({reason:'identity_evidence_required'});
});
it.each([{firstParty:false},{truncated:true},{url:'https://other.test/about'},{retrievedAt:'2026-09-01T00:00:00Z'}])('refuses unusable identity evidence %j',async patch=>{
 const input=await fixture(patch);expect(await tx(()=>correctCandidateName(ctx(),input))).toMatchObject({reason:'identity_evidence_required'});
});
it('refuses identity collisions, dismissed candidates and unresolved wrong-firm feedback',async()=>{
 const input=await fixture();await tx(()=>saveCandidate(ctx(),{...draft,firmName:'Example PM'}));
 expect(await tx(()=>correctCandidateName(ctx(),input))).toMatchObject({reason:'candidate_identity_conflict'});
 await db.session.query("UPDATE sourcing_candidates SET status='dismissed' WHERE id=$1",[input.id]);
 expect(await tx(()=>correctCandidateName(ctx(),input))).toMatchObject({reason:'identity_review_required'});
 await db.session.query("UPDATE sourcing_candidates SET status='needs_review',qualification_blocked=true WHERE id=$1",[input.id]);
 expect(await tx(()=>correctCandidateName(ctx(),input))).toMatchObject({reason:'identity_review_required'});
});
