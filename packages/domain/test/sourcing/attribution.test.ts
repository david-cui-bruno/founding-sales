import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {createFirm} from '../../crm/firms.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {requestQualification} from '../../sourcing/qualificationStore.ts';
import {addPhoneRoute} from '../../crm/routes.ts';
import {attachSourcingAttribution,attributeInteraction,readFirmSourcing,attributeFirmInteraction} from '../../sourcing/attribution.ts';
import {mergeFirms} from '../../crm/merges.ts';
import {recordingSuppressionJournal} from '../../suppression/journal.ts';
let db:TestDatabase;let seeded:TwoWorkspaces;
const ctx=()=>repositoryContext(workspaceScope(seeded.alpha.workspaceId,{kind:'user',userId:seeded.alpha.admin.userId,role:'admin'}),db.session);
const tx=<T>(fn:()=>Promise<T>)=>withTransaction(db.session,fn);
beforeAll(async()=>{db=await createTestDatabase();seeded=await seedTwoWorkspaces(db.session);});
afterAll(async()=>db.drop());
async function firm(){const result=await tx(()=>createFirm(ctx(),{name:`Learning ${randomUUID()}`,assignedUserId:seeded.alpha.admin.userId}));if(!result.ok)throw new Error(result.reason);return result.value.id;}
async function source(firmId:string,hypothesis='operational_burden'){
 const website=`https://pm-${randomUUID()}.example.test/`;
 const candidate=await tx(()=>saveCandidate(ctx(),{firmName:'Fixture PM',website,locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Fixture evidence',sourceUrl:website,observedOn:'2026-10-05',preparedBy:'Fixture'}));if(!candidate.ok)throw new Error(candidate.reason);
 const run=await tx(()=>requestQualification(ctx(),{candidateId:candidate.value.id,expectedRevision:1}));if(!run.ok)throw new Error(run.reason);
 const route=await tx(()=>addPhoneRoute(ctx(),{firmId,e164:'+12145550101',source:'website'}));if(!route.ok)throw new Error(route.reason);
 await db.session.query('INSERT INTO sourcing_admissions(workspace_id,candidate_id,run_id,firm_id,route_id) VALUES($1,$2,$3,$4,$5)',[seeded.alpha.workspaceId,candidate.value.id,run.value.runId,firmId,route.value.id]);
 const input={firmId,candidateId:candidate.value.id,qualificationRunId:run.value.runId,queryId:null,hypothesis,policyVersion:'qualification-v1',acquisition:'cold_sourced' as const};
 const result=await tx(()=>attachSourcingAttribution(ctx(),input));if(!result.ok)throw new Error(result.reason);return {...input,id:result.value.id};
}
async function call(firmId:string){return (await db.session.query<{id:string}>("INSERT INTO call_logs(workspace_id,firm_id,outcome,step_effect,occurred_at,actor_user_id) VALUES($1,$2,'no_answer','none',now(),$3) RETURNING id",[seeded.alpha.workspaceId,firmId,seeded.alpha.admin.userId])).rows[0]!.id;}
it('replays one interaction once and freezes the initial source across later evidence',async()=>{
 const f=await firm(),first=await source(f),callId=await call(f);
 const input={attributionId:first.id,kind:'call' as const,subjectId:callId,sourceRevision:0};
 const one=await tx(()=>attributeInteraction(ctx(),input));expect(one.ok).toBe(true);expect(await tx(()=>attributeInteraction(ctx(),input))).toEqual(one);
 const second=await source(f,'help_request');const next=await call(f);expect((await tx(()=>attributeInteraction(ctx(),{...input,attributionId:second.id,subjectId:next}))).ok).toBe(true);
 const read=await readFirmSourcing(ctx(),f);expect(read?.primary).toMatchObject({id:first.id,hypothesis:'operational_burden',acquisition:'cold_sourced'});expect(read?.interactions).toHaveLength(2);
});
it('keeps a warm introduction separate from source research added after first contact',async()=>{
 const f=await firm();const warm=await tx(()=>attachSourcingAttribution(ctx(),{firmId:f,candidateId:null,qualificationRunId:null,queryId:null,hypothesis:'warm_intro',policyVersion:'manual-v1',acquisition:'warm_intro'}));if(!warm.ok)throw new Error(warm.reason);
 await tx(async()=>attributeInteraction(ctx(),{attributionId:warm.value.id,kind:'call',subjectId:await call(f),sourceRevision:0}));await source(f);
 expect((await readFirmSourcing(ctx(),f))?.primary?.acquisition).toBe('warm_intro');
});
it('does not attach another firm or workspace interaction to this source',async()=>{
 const f=await firm(),s=await source(f),other=await firm();const id=await call(other);
 expect(await tx(async()=>attributeInteraction(ctx(),{attributionId:s.id,kind:'call',subjectId:id,sourceRevision:0}))).toEqual({ok:false,reason:'interaction_mismatch'});
 const beta=repositoryContext(workspaceScope(seeded.beta.workspaceId,{kind:'user',userId:seeded.beta.admin.userId,role:'admin'}),db.session);
 expect(await tx(()=>attributeInteraction(beta,{attributionId:s.id,kind:'call',subjectId:id,sourceRevision:0}))).toEqual({ok:false,reason:'not_found'});
});
it('retains original attribution but reports deleted source evidence unavailable',async()=>{
 const f=await firm(),s=await source(f),id=await call(f);await tx(async()=>attributeInteraction(ctx(),{attributionId:s.id,kind:'call',subjectId:id,sourceRevision:0}));
 await db.session.query('DELETE FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2',[seeded.alpha.workspaceId,s.candidateId]);
 expect((await readFirmSourcing(ctx(),f))?.primary).toMatchObject({id:s.id,acquisition:'unknown',sourceAvailable:false});
});
it('merges into one surviving cohort and preserves both interaction histories',async()=>{
 const a=await firm(),b=await firm(),sa=await source(a),sb=await source(b);
 const firstCall=await call(a);await db.session.query("UPDATE call_logs SET occurred_at=now()-interval '1 second' WHERE id=$1",[firstCall]);
 await tx(async()=>attributeInteraction(ctx(),{attributionId:sa.id,kind:'call',subjectId:firstCall,sourceRevision:0}));
 await tx(async()=>attributeInteraction(ctx(),{attributionId:sb.id,kind:'call',subjectId:await call(b),sourceRevision:0}));
 expect((await tx(()=>mergeFirms(ctx(),{sourceFirmId:a,targetFirmId:b,journal:recordingSuppressionJournal()}))).ok).toBe(true);
 const read=await readFirmSourcing(ctx(),b);expect(read?.primary?.id).toBe(sa.id);expect(read?.interactions).toHaveLength(2);
 expect(await readFirmSourcing(ctx(),a)).toBeNull();
});
it('records unknown legacy contact without guessing a source or changing CRM stage',async()=>{
 const f=await firm(),id=await call(f);await tx(()=>attributeFirmInteraction(ctx(),{firmId:f,kind:'call',subjectId:id,sourceRevision:0}));
 expect((await readFirmSourcing(ctx(),f))?.primary?.acquisition).toBe('unknown');
 expect((await db.session.query('SELECT id FROM opportunities WHERE workspace_id=$1 AND firm_id=$2',[seeded.alpha.workspaceId,f])).rows).toHaveLength(0);
});
it('records an accepted correction as another revision of the same call, with its original source',async()=>{
 const {logCallOutcome}=await import('../../dial/calls.ts');
 const {correctCallOutcome,previewOutcomeCorrection}=await import('../../calls/correctOutcome.ts');
 const f=await firm(),s=await source(f);
 const log=await tx(()=>logCallOutcome(ctx(),{firmId:f,outcome:'no_answer',commandId:randomUUID()}));if(!log.ok)throw new Error(log.reason);
 await source(f,'help_request');
 const preview=await previewOutcomeCorrection(ctx(),{callLogId:log.value.callLogId,outcome:'busy'});if(!preview.ok)throw new Error(preview.reason);
 const corrected=await tx(()=>correctCallOutcome(ctx(),{callLogId:log.value.callLogId,expectedOutcome:'no_answer',outcome:'busy',effects:[],commandId:randomUUID(),journal:recordingSuppressionJournal()}));expect(corrected.ok,JSON.stringify(corrected)).toBe(true);
 const rows=(await db.session.query<{attribution_id:string;source_revision:number}>('SELECT attribution_id,source_revision FROM sourcing_interactions WHERE workspace_id=$1 AND subject_id=$2 ORDER BY source_revision',[seeded.alpha.workspaceId,log.value.callLogId])).rows;
 expect(rows).toEqual([{attribution_id:s.id,source_revision:0},{attribution_id:s.id,source_revision:1}]);
 expect(await tx(()=>attributeInteraction(ctx(),{attributionId:s.id,kind:'call',subjectId:log.value.callLogId,sourceRevision:0}))).toEqual({ok:false,reason:'source_changed'});
});
it('a backdated manually logged call does not acquire a source found later',async()=>{
 const {logCallOutcome}=await import('../../dial/calls.ts');const f=await firm();await source(f);
 const log=await tx(()=>logCallOutcome(ctx(),{firmId:f,outcome:'no_answer',occurredAt:new Date(Date.now()-86400000).toISOString(),commandId:randomUUID()}));expect(log.ok).toBe(true);
 expect((await readFirmSourcing(ctx(),f))?.primary?.acquisition).toBe('unknown');
});
it('preserves unknown acquisition when research is attached to a firm contacted before this feature',async()=>{
 const f=await firm();const old=await call(f);await db.session.query("UPDATE call_logs SET occurred_at=now()-interval '1 day' WHERE id=$1",[old]);
 await source(f);const next=await call(f);await tx(()=>attributeFirmInteraction(ctx(),{firmId:f,kind:'call',subjectId:next}));
 expect((await readFirmSourcing(ctx(),f))?.primary?.acquisition).toBe('unknown');
});
it('keeps a legacy manual firm out of a new first-contact cohort on its next call',async()=>{
 const f=await firm(),old=await call(f);const date='2026-01-03T14:00:00.000Z';
 await db.session.query('UPDATE call_logs SET occurred_at=$2 WHERE id=$1',[old,date]);
 const next=await call(f);await tx(()=>attributeFirmInteraction(ctx(),{firmId:f,kind:'call',subjectId:next}));
 expect((await readFirmSourcing(ctx(),f))?.firstContactedAt).toBe(date);
});
