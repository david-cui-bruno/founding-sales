import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {createFirm} from '../../crm/firms.ts';
import {addPhoneRoute} from '../../crm/routes.ts';
import {createPerson,addSelectedSource,changeSelectedSource} from '../../crm/people.ts';
import {saveRelationship} from '../../crm/relationships.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {saveManualProspectActivity} from '../../sourcing/manualProspectActivity.ts';
import {manualOrdinaryFixture} from './support/manualProspectFixture.ts';
import {manualPhoneFixture,seedManualPhoneRun} from './support/manualPhoneFixture.ts';
import {listProspectPriority,saveProspectPriority,considerProspectPriority,readProspectPriorityLearning} from '../../sourcing/prospectPriority.ts';
let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable;
const ctx=()=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),runtime);
const tx=<T>(fn:()=>Promise<T>)=>withTransaction(runtime,fn);
async function candidate(){const r=await tx(()=>saveCandidate(ctx(),manualOrdinaryFixture()));if(!r.ok)throw Error(r.reason);return r.value.id;}
async function roleFixture(){
 const candidateId=await candidate(),firm=await tx(()=>createFirm(ctx(),{name:'Fictional role proof',assignedUserId:seed.alpha.admin.userId}));if(!firm.ok)throw Error(firm.reason);
 const route=await tx(()=>addPhoneRoute(ctx(),{firmId:firm.value.id,e164:'+12145550101',source:'website'}));if(!route.ok)throw Error(route.reason);
 const run=await seedManualPhoneRun(runtime,seed.alpha.workspaceId,candidateId,manualPhoneFixture(manualOrdinaryFixture().sourceUrl,[]));
 await runtime.query('INSERT INTO sourcing_admissions(workspace_id,candidate_id,run_id,firm_id,route_id) VALUES($1,$2,$3,$4,$5)',[seed.alpha.workspaceId,candidateId,run,firm.value.id,route.value.id]);
 const person=await tx(()=>createPerson(ctx(),'Fictional Person'));if(!person.ok||!person.value.personId)throw Error('person_fixture');const personId=person.value.personId;
 const excerpt='Fictional direct note about this person and firm.';
 const source=await tx(()=>addSelectedSource(ctx(),{personId,sourceKey:randomUUID(),excerpt,occurredAt:new Date().toISOString()}));if(!source.ok||!source.value.sourceId)throw Error('source_fixture');const sourceId=source.value.sourceId;
 const relation=await tx(()=>saveRelationship(ctx(),{commandId:randomUUID(),clientVersion:'1.0.0',personId,firmId:firm.value.id,status:'current',startDate:null,endDate:null,evidence:{sourceId,sourceRevision:1,contentHash:createHash('sha256').update(excerpt).digest('hex')}}));if(!relation.ok||!relation.value.relationshipId)throw Error('relationship_fixture');
 return {candidateId,personId,relationshipId:relation.value.relationshipId,sourceId};
}
const save=(f:Awaited<ReturnType<typeof roleFixture>>,basis:'hypothesis'|'source_supported'|'directly_confirmed',expectedAssessmentRevision=0)=>tx(()=>saveProspectPriority(ctx(),{candidateId:f.candidateId,expectedCandidateRevision:1,expectedAssessmentRevision,fit:'positive',value:'unknown',timing:'unknown',sourceUrl:manualOrdinaryFixture().sourceUrl,roles:[{personId:f.personId,relationshipId:f.relationshipId,relationshipRevision:1,role:'workflow_owner',basis}]}));
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
beforeEach(async()=>{await db.session.query('DELETE FROM sourcing_candidates');});
afterAll(async()=>{await db.drop();});
it('association supports a Person chooser but a declared hypothesis never becomes established buying responsibility',async()=>{
 const f=await roleFixture();expect(await save(f,'hypothesis')).toMatchObject({ok:true});
 expect(await tx(()=>listProspectPriority(ctx(),{state:'all',offset:0}))).toMatchObject({ok:true,value:{prospects:[{priority:{roles:[{basis:'hypothesis'}],roleState:'hypothesis',nextAction:'research_person',roleCandidates:[{personName:'Fictional Person'}]}}]}});
 expect(await save(f,'directly_confirmed',1)).toMatchObject({ok:true});
 expect(await tx(()=>listProspectPriority(ctx(),{state:'all',offset:0}))).toMatchObject({ok:true,value:{prospects:[{priority:{roleState:'supported',nextAction:'research_route',roles:[{basis:'directly_confirmed'}]}}]}});
});
it('benign role correction preserves selection dimensions while actual role-source erasure clears historical role references and kinds',async()=>{
 const f=await roleFixture();await save(f,'source_supported');
 expect(await tx(()=>considerProspectPriority(ctx(),{candidateId:f.candidateId,expectedCandidateRevision:1,expectedAssessmentRevision:1,disposition:'selected'}))).toMatchObject({ok:true});
 await runtime.query("UPDATE crm_people SET full_name='Corrected Person spelling',revision=revision+1 WHERE id=$1",[f.personId]);
 expect((await runtime.query('SELECT fit,roles,role_kinds FROM sourcing_prospect_considerations')).rows).toEqual([{fit:'positive',roles:[],role_kinds:['workflow_owner']}]);
 await runtime.query("UPDATE crm_relationships SET revision=revision+1,context_review='required' WHERE id=$1",[f.relationshipId]);
 expect((await runtime.query('SELECT fit,roles,role_kinds,role_source_ids FROM sourcing_prospect_considerations')).rows).toEqual([{fit:'positive',roles:[],role_kinds:['workflow_owner'],role_source_ids:[f.sourceId]}]);
 expect(await tx(()=>listProspectPriority(ctx(),{state:'all',offset:0}))).toMatchObject({ok:true,value:{prospects:[{priority:{fit:'unknown',roleState:'unknown',roles:[]}}]}});
 expect(await tx(()=>changeSelectedSource(ctx(),{personId:f.personId,sourceId:f.sourceId,expectedRevision:1},'delete'))).toMatchObject({ok:true});
 expect((await runtime.query('SELECT fit,roles,role_kinds,role_source_ids FROM sourcing_prospect_considerations')).rows).toEqual([{fit:'positive',roles:[],role_kinds:[],role_source_ids:[]}]);
});
it('database rejects null role values and immutable selection rewrite',async()=>{
 const f=await roleFixture();await save(f,'hypothesis');
 const malformed=[{personId:f.personId,relationshipId:f.relationshipId,relationshipRevision:1,role:null,basis:'hypothesis'}];
 await expect(runtime.query('UPDATE sourcing_prospect_priorities SET roles=$2::jsonb WHERE candidate_id=$1',[f.candidateId,JSON.stringify(malformed)])).rejects.toMatchObject({code:'23514'});
 await tx(()=>considerProspectPriority(ctx(),{candidateId:f.candidateId,expectedCandidateRevision:1,expectedAssessmentRevision:1,disposition:'selected'}));
 await expect(runtime.query("UPDATE sourcing_prospect_considerations SET fit='negative'")).rejects.toMatchObject({code:'23514'});
});
it('uses first selected revision consistently and separates known post-selection outcomes from historical or unknown-time reports',async()=>{
 const id=await candidate();await tx(()=>considerProspectPriority(ctx(),{candidateId:id,expectedCandidateRevision:1,expectedAssessmentRevision:0,disposition:'considered'}));
 await runtime.query('UPDATE sourcing_candidates SET revision=2 WHERE id=$1',[id]);
 await tx(()=>considerProspectPriority(ctx(),{candidateId:id,expectedCandidateRevision:2,expectedAssessmentRevision:0,disposition:'selected'}));
 await runtime.query('SELECT pg_sleep(0.01)');
 const content={performedByUser:true as const,channel:'manual_phone' as const,result:'conversation' as const,note:null,callback:null};
 for(const occurrence of [{kind:'known' as const,occurredAt:new Date(Date.now()-3600000).toISOString()},{kind:'unknown' as const},{kind:'known' as const,occurredAt:new Date().toISOString()}]){
  expect(await tx(()=>saveManualProspectActivity(ctx(),{...content,operation:'create',candidateId:id,expectedCandidateRevision:2,attemptId:randomUUID(),occurrence},async()=>true))).toMatchObject({ok:true});
 }
 const from=new Date(Date.now()-10000).toISOString(),to=new Date(Date.now()+10000).toISOString();
 const report=await tx(()=>readProspectPriorityLearning(ctx(),{from,to}));
 expect(report).toMatchObject({ok:true,value:{considered:1,selected:1,reportedAttempts:1,unplacedReportedAttempts:1,observations:{conversation:1,unknown:0},cohorts:[{selected:1,reportedAttempts:1,unplacedReportedAttempts:1,conversation:1,unknown:0}]}});
});
it('last authority wait across assessment expiry refuses stale reasons instead of returning them',async()=>{
 const id=await candidate();await tx(()=>saveProspectPriority(ctx(),{candidateId:id,expectedCandidateRevision:1,expectedAssessmentRevision:0,fit:'positive',value:'unknown',timing:'unknown',roles:[],sourceUrl:manualOrdinaryFixture().sourceUrl}));
 await runtime.query("UPDATE sourcing_prospect_priorities SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE candidate_id=$1",[id]);
 let calls=0;
 const result=await tx(()=>listProspectPriority(ctx(),{state:'all',offset:0},async()=>{calls++;if(calls===3)await runtime.query('SELECT pg_sleep(0.4)');return true;}));
 expect(result).toMatchObject({ok:false});
});

it('role-owner wait crossing assessment expiry refuses cleanly before selection insert',async()=>{
 const f=await roleFixture();await save(f,'source_supported');
 await runtime.query("UPDATE sourcing_prospect_priorities SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE candidate_id=$1",[f.candidateId]);
 const blocker=await db.appRuntimeSession(),reader=await db.appRuntimeSession();
 await blocker.query('BEGIN');await blocker.query('SELECT id FROM crm_people WHERE id=$1 FOR UPDATE',[f.personId]);
 const pid=(await reader.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
 const context=repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),reader);
 const pending=withTransaction(reader,()=>considerProspectPriority(context,{candidateId:f.candidateId,expectedCandidateRevision:1,expectedAssessmentRevision:1,disposition:'selected'})).then(value=>({value}),error=>({reason:error instanceof Error?error.message:String(error)}));
 try{await expect.poll(async()=>String((await db.session.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.['wait_event_type'])).toBe('Lock');await blocker.query('SELECT pg_sleep(0.6)');}finally{await blocker.query('COMMIT');}
 expect(await pending).toEqual({reason:'source_expired'});
 expect((await runtime.query('SELECT * FROM sourcing_prospect_considerations')).rows).toEqual([]);
});
