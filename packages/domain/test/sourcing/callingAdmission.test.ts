import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import type {CandidateInput,SourceObservation} from '@fss/contracts';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {saveCandidate,deleteCandidate,reviewCandidate} from '../../sourcing/candidates.ts';
import {requestQualification,finishQualification} from '../../sourcing/qualificationStore.ts';
import {admitCallingCandidate} from '../../sourcing/callingAdmission.ts';
import {readCallingAssessment} from '../../research/callingAssessmentStore.ts';
import {recordStatePosture} from '../../policy/postures.ts';
import {POSTURE_STATEMENTS} from '../../src/rules/statePosture.ts';
let db:TestDatabase,seed:TwoWorkspaces,serial=300;
const context=(workspace:'alpha'|'beta'='alpha',role:'admin'|'salesperson'='admin')=>repositoryContext(workspaceScope(seed[workspace].workspaceId,{kind:'user',role,userId:seed[workspace][role].userId}),db.session);
const tx=<T>(fn:()=>Promise<T>)=>withTransaction(db.session,fn);
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);await tx(()=>recordStatePosture(context(),{state:'TX',effectiveFrom:new Date(Date.now()-60000).toISOString(),confirmedStatements:Object.keys(POSTURE_STATEMENTS)}));});
afterAll(async()=>db.drop());
async function draft(){
 const n=serial++,payload:CandidateInput={firmName:`Calling Only ${n}`,website:`https://calling-${n}.example.test/`,sourceUrl:`https://calling-${n}.example.test/`,locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Search only',observedOn:new Date().toISOString().slice(0,10),preparedBy:'Synthetic fixture'};
 const saved=await tx(()=>saveCandidate(context(),payload));if(!saved.ok)throw new Error(saved.reason);
 const requested=await tx(()=>requestQualification(context(),{candidateId:saved.value.id,expectedRevision:1},{enqueue:false}));if(!requested.ok)throw new Error(requested.reason);
 const phone=`+1214555${n.toString().padStart(4,'0')}`;
 const blocks=[{id:'identity',text:payload.firmName},{id:'fit',text:'We manage residential rentals.'},{id:'area',text:'Dallas'},{id:'phone',text:`For help with your rental, reach us at ${phone}.`}];
 const source:SourceObservation={id:randomUUID(),url:payload.website,contentHash:'a'.repeat(64),relevantTextHash:createHash('sha256').update(JSON.stringify(blocks)).digest('hex'),retrievedAt:new Date(Date.now()-1000).toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks};
 const done=await tx(()=>finishQualification(context(),{runId:requested.value.runId,observations:[source],facts:[],reason:'invalid_evidence'}));if(!done.ok)throw new Error(done.reason);
 return {candidateId:saved.value.id,expectedRevision:1,qualificationRunId:requested.value.runId,phone};
}
const admit=(input:Awaited<ReturnType<typeof draft>>)=>tx(()=>admitCallingCandidate(context(),input));
const strictState=async(id:string)=>(await db.session.query('SELECT * FROM sourcing_qualification_runs WHERE id=$1',[id])).rows[0];
it('onboards only firm/phone under a distinct immutable audit, preserving strict state and idempotence',async()=>{
 const d=await draft(),before=await strictState(d.qualificationRunId);
 const result=await admit(d);expect(result,JSON.stringify(result)).toMatchObject({ok:true,value:{createdFirm:true,policyVersion:'calling-first-party-tx-v1'}});if(!result.ok)throw new Error(result.reason);
 const value=result.value;
 expect(await strictState(d.qualificationRunId)).toEqual(before);
 expect((await db.session.query('SELECT candidate_id FROM sourcing_admissions WHERE candidate_id=$1',[d.candidateId])).rows).toEqual([]);
 expect((await db.session.query('SELECT id FROM email_addresses WHERE firm_id=$1',[value.firmId])).rows).toEqual([]);
 expect((await db.session.query('SELECT id FROM sequence_enrollments WHERE firm_id=$1',[value.firmId])).rows).toEqual([]);
 const audit=(await db.session.query<{detail:unknown}>('SELECT detail FROM audit_events WHERE id=$1',[value.assessmentId])).rows[0]!.detail;
 expect(audit).toMatchObject({parentKind:'qualification_run',parentId:d.qualificationRunId,candidateId:d.candidateId,expectedSourceCount:1});
 expect(JSON.stringify(audit)).not.toContain(d.phone);expect(JSON.stringify(audit)).not.toContain('Calling Only');expect(JSON.stringify(audit)).not.toContain('https:');
 const again=await admit(d);expect(again).toMatchObject({ok:true,value:{assessmentId:value.assessmentId,routeId:value.routeId,createdFirm:false}});
 expect((await db.session.query('SELECT id FROM phone_routes WHERE firm_id=$1',[value.firmId])).rows).toHaveLength(1);
 const proof=()=>tx(()=>readCallingAssessment(context(),{...value,e164:d.phone,at:new Date().toISOString(),expectedAuditId:value.assessmentId}));
 expect(await proof()).toMatchObject({kind:'proof',assessmentId:value.assessmentId});
 await tx(()=>deleteCandidate(context(),{id:d.candidateId,expectedRevision:1}));
 expect(await proof()).toEqual({kind:'invalid'});
 expect((await db.session.query('SELECT id FROM audit_events WHERE id=$1',[value.assessmentId])).rows).toHaveLength(1);
});
it('refuses salespeople, cross-workspace, pending and stale revisions without creating a firm',async()=>{
 const d=await draft();
 expect(await tx(()=>admitCallingCandidate(context('alpha','salesperson'),d))).toEqual({ok:false,reason:'admin_only'});
 expect(await tx(()=>admitCallingCandidate(context('beta'),d))).toEqual({ok:false,reason:'not_found'});
 await tx(()=>reviewCandidate(context(),{id:d.candidateId,expectedRevision:1,status:'kept'}));
 expect(await admit(d)).toEqual({ok:false,reason:'candidate_changed'});
});
it.each(['hash','truncated','personal','expired'] as const)('holds %s source changes without CRM or admission writes',async(kind)=>{
 const d=await draft();
 const row=(await db.session.query<{observations:SourceObservation[]}>('SELECT observations FROM sourcing_qualification_runs WHERE id=$1',[d.qualificationRunId])).rows[0]!,source=row.observations[0]!;
 if(kind==='hash')source.relevantTextHash='f'.repeat(64);
 if(kind==='truncated')source.truncated=true;
 if(kind==='expired')source.retrievedAt=new Date(Date.now()-8*86400000).toISOString();
 if(kind==='personal'){source.blocks.push({id:'personal',text:`Mobile ${d.phone}`});source.relevantTextHash=createHash('sha256').update(JSON.stringify(source.blocks)).digest('hex');}
 await db.session.query('UPDATE sourcing_qualification_runs SET observations=$2::jsonb WHERE id=$1',[d.qualificationRunId,JSON.stringify(row.observations)]);
 const before=(await db.session.query('SELECT id FROM firms ORDER BY id')).rows;
 expect((await admit(d)).ok).toBe(false);
 expect((await db.session.query('SELECT id FROM firms ORDER BY id')).rows).toEqual(before);
 expect((await db.session.query('SELECT candidate_id FROM sourcing_admissions WHERE candidate_id=$1',[d.candidateId])).rows).toEqual([]);
});
it.each(['fingerprint','policy','revision'] as const)('fails live audit reconstruction on %s drift',async(kind)=>{
 const d=await draft(),result=await admit(d);if(!result.ok)throw new Error(result.reason);
 const value=result.value,target={...value,e164:d.phone,at:new Date().toISOString(),expectedAuditId:value.assessmentId};
 if(kind==='fingerprint')await db.session.query("UPDATE sourcing_qualification_runs SET facts='[]',observations=jsonb_set(observations,'{0,contentHash}',to_jsonb(repeat('c',64))) WHERE id=$1",[d.qualificationRunId]);
 if(kind==='policy')await db.session.query("UPDATE sourcing_qualification_runs SET policy_version='other' WHERE id=$1",[d.qualificationRunId]);
 if(kind==='revision')await tx(()=>reviewCandidate(context(),{id:d.candidateId,expectedRevision:1,status:'kept'}));
 expect(await tx(()=>readCallingAssessment(context(),target))).toEqual({kind:'invalid'});
});
