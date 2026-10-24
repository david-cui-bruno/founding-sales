import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID,createHash} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {seedRetainedRecovery} from './retainedRecoveryFixture.ts';
import {decideRetainedIdentity,interpretRetainedQualification} from '../../sourcing/retainedRecovery.ts';
import {literalName} from '../../sourcing/retainedRecoveryEvidence.ts';
import {readQualification,requestQualification} from '../../sourcing/qualificationStore.ts';
import {admitCandidate} from '../../sourcing/admission.ts';
import {requestSourceCheck,runSourceCheck} from '../../sourcing/sourceCheck.ts';
import {runQualification} from '../../sourcing/qualificationRun.ts';
import {retainedFirmOnly,retainedWallNow} from '../../sourcing/retainedAcquisition.ts';
import {enqueueFirmResearch} from '../../research/enqueue.ts';
import {selectFirmsForSweep} from '../../research/sweep.ts';
import {recordStatePosture} from '../../policy/postures.ts';
import {POSTURE_STATEMENTS} from '../../src/rules/statePosture.ts';
import {deleteCandidate,reviewCandidate} from '../../sourcing/candidates.ts';
import {mergeFirms} from '../../crm/merges.ts';
import {recordingSuppressionJournal} from '../../suppression/journal.ts';
import {reserveAttempt,markCalling,settleAttempt} from '../../research/reservations.ts';
let db:TestDatabase,seed:TwoWorkspaces;
const ctx=(workspace:'alpha'|'beta'='alpha',role:'admin'|'salesperson'='admin')=>repositoryContext(workspaceScope(seed[workspace].workspaceId,{kind:'user',userId:seed[workspace][role].userId,role}),db.session);
const tx=<T>(work:()=>Promise<T>)=>withTransaction(db.session,work);
const fixture=()=>tx(()=>seedRetainedRecovery(ctx()));
const original=async(id:string)=>(await db.session.query('SELECT * FROM sourcing_qualification_runs WHERE id=$1',[id])).rows[0];
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);});
beforeEach(async()=>{await db.session.query('TRUNCATE sourcing_candidates,firms,jobs,daily_counters CASCADE');});
afterAll(async()=>{await db.drop();});
it('records identity only, preserves rejection, then interprets full originals through existing qualifier',async()=>{
 const f=await fixture(),old=await original(f.runId);
 const decided=await tx(()=>decideRetainedIdentity(ctx(),f.identity));expect(decided.ok).toBe(true);if(!decided.ok)throw Error(decided.reason);
 expect(await original(f.runId)).toEqual(old);
 expect(await readQualification(ctx(),{candidateId:f.candidateId})).toMatchObject({runId:f.runId,candidateRevision:1,currentCandidateRevision:2,status:'unavailable',facts:[],verdict:null,recovery:{decisionId:decided.value.decisionId,interpretationRunId:null}});
 expect((await db.session.query('SELECT id FROM firms')).rows).toHaveLength(0);
 const interpreted=await tx(()=>interpretRetainedQualification(ctx(),f.interpretation(decided.value.decisionId)));expect(interpreted.ok).toBe(true);if(!interpreted.ok)throw Error(interpreted.reason);
 expect(await readQualification(ctx(),{candidateId:f.candidateId})).toMatchObject({runId:interpreted.value.runId,status:'eligible',interpretationOrigin:'human_retained',observations:[f.source],verdict:{decision:'eligible'}});
 expect(await original(f.runId)).toEqual(old);
 const completed=await original(interpreted.value.runId);expect((completed?.['finished_at'] as Date).getTime()).toBeGreaterThanOrEqual((completed?.['requested_at'] as Date).getTime());
 const audits=(await db.session.query("SELECT detail FROM audit_events WHERE action LIKE 'sourcing.retained%' AND subject_id=$1",[f.candidateId])).rows;
 expect(JSON.stringify(audits)).not.toContain(f.firmName);expect(JSON.stringify(audits)).not.toContain(f.source.blocks[0]!.text);
 for(const table of ['jobs','provider_reservations','daily_counters'])expect((await db.session.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.['n']).toBe(0);
});
it('refuses wrong workspace/admin/system, stale revision and unsupported literal spans without mutation',async()=>{
 const f=await fixture();
 expect(await tx(()=>decideRetainedIdentity(ctx('beta'),f.identity))).toMatchObject({ok:false});
 expect(await tx(()=>decideRetainedIdentity(ctx('alpha','salesperson'),f.identity))).toMatchObject({reason:'admin_only'});
 expect(await tx(()=>decideRetainedIdentity(repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'system',component:'worker'}),db.session),f.identity))).toMatchObject({reason:'admin_only'});
 for(const patch of [{expectedRevision:2},{nameStart:0,nameEnd:1},{contentHash:'0'.repeat(64)},{blockId:'missing'}])expect(await tx(()=>decideRetainedIdentity(ctx(),{...f.identity,...patch}))).toMatchObject({ok:false});
 expect(literalName('A😀B',2,4)).toBeNull();
 expect((await db.session.query('SELECT id FROM sourcing_retained_identity_decisions')).rows).toHaveLength(0);
});
it.each(['stale','future','truncated','foreign','hash','diagnostic','newer','queued','unknown'] as const)('refuses %s original provenance or acquisition without clearing the original rejection',async mode=>{
 const f=mode==='diagnostic'?await tx(()=>seedRetainedRecovery(ctx(),'',false)):await fixture();
 if(mode==='newer')await db.session.query(`INSERT INTO sourcing_qualification_runs(workspace_id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name) SELECT workspace_id,candidate_id,candidate_revision,$2,prompt_version,policy_version,model_name FROM sourcing_qualification_runs WHERE id=$1`,[f.runId,'b'.repeat(64)]);
 else if(mode==='queued')await db.session.query(`INSERT INTO jobs(workspace_id,kind,idempotency_key,payload) VALUES($1,'sourcing.check',$2,$3::jsonb)`,[seed.alpha.workspaceId,randomUUID(),JSON.stringify({candidateId:f.candidateId,checkId:randomUUID()})]);
 else if(mode==='unknown')await tx(async()=>{const at=await retainedWallNow(ctx()),r=await reserveAttempt(ctx(),{subjectKind:'sourcing_qualification',subjectId:f.runId,attempt:1,providerKey:'aws_bedrock.sourcing_qualification',at,businessTimeZone:'America/New_York',cents:1,modelName:'claude-haiku-4-5',maxInputTokens:100,maxOutputTokens:100});await markCalling(ctx(),r.id);await settleAttempt(ctx(),{reservationId:r.id,at,outcome:{kind:'estimated'}});});
 else if(mode!=='diagnostic'){
  const source={...f.source,...(mode==='stale'?{retrievedAt:'2020-01-01T00:00:00Z'}:mode==='future'?{retrievedAt:new Date(Date.now()+60000).toISOString()}:mode==='truncated'?{truncated:true}:mode==='foreign'?{url:'https://foreign.example.test/'}:{relevantTextHash:'0'.repeat(64)})};
  await db.session.query('UPDATE sourcing_qualification_runs SET observations=$2::jsonb WHERE id=$1',[f.runId,JSON.stringify([source])]);
 }
 const old=await original(f.runId);expect(await tx(()=>decideRetainedIdentity(ctx(),f.identity))).toMatchObject({ok:false});expect(await original(f.runId)).toEqual(old);
});
it('whole-selection failure rolls back the new run, keeps decision, and never silently drops contrary identity',async()=>{
 const f=await fixture(),d=await tx(()=>decideRetainedIdentity(ctx(),f.identity));if(!d.ok)throw Error(d.reason);
 const input=f.interpretation(d.value.decisionId);input.selections[0]={...input.selections[0]!,blockId:'need'};
 expect(await tx(()=>interpretRetainedQualification(ctx(),input))).toMatchObject({reason:'invalid_evidence'});
 expect((await db.session.query('SELECT id FROM sourcing_qualification_runs WHERE candidate_id=$1',[f.candidateId])).rows).toHaveLength(1);
 expect((await db.session.query('SELECT id FROM sourcing_retained_identity_decisions')).rows).toHaveLength(1);
});
it('serializes concurrent duplicate identity decisions and refuses a second interpretation',async()=>{
 const f=await fixture(),second=await db.appRuntimeSession(),other=repositoryContext(ctx().scope,second);
 const results=await Promise.all([tx(()=>decideRetainedIdentity(ctx(),f.identity)),withTransaction(second,()=>decideRetainedIdentity(other,f.identity))]);
 expect(results.filter(r=>r.ok)).toHaveLength(1);expect((await db.session.query('SELECT id FROM sourcing_retained_identity_decisions')).rows).toHaveLength(1);
 const winner=results.find(r=>r.ok);if(!winner?.ok)throw Error('No identity decision');
 const input=f.interpretation(winner.value.decisionId);expect((await tx(()=>interpretRetainedQualification(ctx(),input))).ok).toBe(true);
 expect(await tx(()=>interpretRetainedQualification(ctx(),input))).toMatchObject({ok:false});expect((await db.session.query('SELECT id FROM sourcing_qualification_runs')).rows).toHaveLength(2);
});
it('serializes a source request against the retained decision so both cannot acquire authority',async()=>{
 const f=await fixture(),second=await db.appRuntimeSession(),other=repositoryContext(ctx().scope,second);
 await db.session.query('INSERT INTO research_settings(workspace_id,enabled,daily_firm_ceiling) VALUES($1,true,100) ON CONFLICT(workspace_id) DO UPDATE SET enabled=true,daily_firm_ceiling=100',[seed.alpha.workspaceId]);
 const [decision,request]=await Promise.all([tx(()=>decideRetainedIdentity(ctx(),f.identity)),withTransaction(second,()=>requestSourceCheck(other,{id:f.candidateId,expectedRevision:1}))]);
 expect(decision.ok&&request.ok).toBe(false);expect(decision.ok||request.ok).toBe(true);
});
it('uses walltime after a candidate-lock wait, not the transaction-start clock for retained freshness',async()=>{
 const f=await fixture(),second=await db.appRuntimeSession();
 const source={...f.source,retrievedAt:new Date(Date.now()-7*86400000+150).toISOString()};
 await db.session.query('UPDATE sourcing_qualification_runs SET observations=$2::jsonb WHERE id=$1',[f.runId,JSON.stringify([source])]);
 await second.query('BEGIN');await second.query('SELECT id FROM sourcing_candidates WHERE id=$1 FOR UPDATE',[f.candidateId]);
 const waiting=tx(()=>decideRetainedIdentity(ctx(),f.identity));
 try{await delay(250);}finally{await second.query('COMMIT');}
 expect(await waiting).toMatchObject({reason:'identity_evidence_required'});expect((await db.session.query('SELECT id FROM sourcing_retained_identity_decisions')).rows).toHaveLength(0);
});
it('does not borrow a separate identity block to qualify an unassociated phone or admit a review-only result',async()=>{
 const f=await fixture(),source={...f.source,blocks:f.source.blocks.map(b=>b.id==='phone'?{...b,text:'Call (214) 555-0186.'}:b)};
 source.relevantTextHash=createHash('sha256').update(JSON.stringify(source.blocks)).digest('hex');
 await db.session.query('UPDATE sourcing_qualification_runs SET observations=$2::jsonb WHERE id=$1',[f.runId,JSON.stringify([source])]);
 const d=await tx(()=>decideRetainedIdentity(ctx(),{...f.identity,relevantTextHash:source.relevantTextHash}));if(!d.ok)throw Error(d.reason);
 const input=f.interpretation(d.value.decisionId);input.selections=input.selections.map(s=>({...s,relevantTextHash:source.relevantTextHash}));
 const made=await tx(()=>interpretRetainedQualification(ctx(),input));expect(made.ok).toBe(true);if(!made.ok)throw Error(made.reason);
 expect(await readQualification(ctx(),{candidateId:f.candidateId})).toMatchObject({status:'review',verdict:{decision:'review',unknowns:expect.arrayContaining(['business_phone_unresolved'])}});
 expect(await tx(()=>admitCandidate(ctx(),{candidateId:f.candidateId,expectedRevision:2,qualificationRunId:made.value.runId,mode:'reviewed'}))).toMatchObject({ok:false});expect((await db.session.query('SELECT id FROM firms')).rows).toHaveLength(0);
});
it('refuses reused-Firm admission while any queued research remains then fences it before canonical handoff',async()=>{
 const f=await fixture(),d=await tx(()=>decideRetainedIdentity(ctx(),f.identity));if(!d.ok)throw Error(d.reason);
 const made=await tx(()=>interpretRetainedQualification(ctx(),f.interpretation(d.value.decisionId)));if(!made.ok)throw Error(made.reason);
 await tx(()=>recordStatePosture(ctx(),{state:'TX',effectiveFrom:new Date(Date.now()-60000).toISOString(),confirmedStatements:Object.keys(POSTURE_STATEMENTS)}));
 const firmId=randomUUID(),jobId=randomUUID();await db.session.query("INSERT INTO firms(workspace_id,id,name,website,locality,region_code,assigned_user_id) VALUES($1,$2,$3,$4,'Dallas','TX',$5)",[seed.alpha.workspaceId,firmId,f.firmName,f.website,seed.alpha.admin.userId]);
 await db.session.query("INSERT INTO jobs(workspace_id,id,kind,idempotency_key,payload) VALUES($1,$2::uuid,'research.firm',$2::text,$3::jsonb)",[seed.alpha.workspaceId,jobId,JSON.stringify({firmId,revision:1,trigger:'firm_created'})]);
 const admission={candidateId:f.candidateId,expectedRevision:2,qualificationRunId:made.value.runId,mode:'reviewed' as const};
 expect(await tx(()=>admitCandidate(ctx(),admission))).toMatchObject({reason:'acquisition_in_progress'});expect(await retainedFirmOnly(ctx(),firmId)).toBe(false);
 await db.session.query('DELETE FROM jobs WHERE id=$1',[jobId]);expect(await tx(()=>admitCandidate(ctx(),admission))).toMatchObject({ok:true,value:{firmId}});expect(await retainedFirmOnly(ctx(),firmId)).toBe(true);expect((await db.session.query('SELECT id FROM jobs')).rows).toHaveLength(0);
});
it('fences direct/queued candidates across status/revision and survives reviewed Firm admission and source deletion',async()=>{
 const f=await fixture(),d=await tx(()=>decideRetainedIdentity(ctx(),f.identity));if(!d.ok)throw Error(d.reason);
 const interpreted=await tx(()=>interpretRetainedQualification(ctx(),f.interpretation(d.value.decisionId)));if(!interpreted.ok)throw Error(interpreted.reason);
 await tx(()=>recordStatePosture(ctx(),{state:'TX',effectiveFrom:new Date(Date.now()-60000).toISOString(),confirmedStatements:Object.keys(POSTURE_STATEMENTS)}));
 const admitted=await tx(()=>admitCandidate(ctx(),{candidateId:f.candidateId,expectedRevision:2,qualificationRunId:interpreted.value.runId,mode:'reviewed'}));expect(admitted.ok).toBe(true);if(!admitted.ok)throw Error(admitted.reason);
 expect(await retainedFirmOnly(ctx(),admitted.value.firmId)).toBe(true);
 expect((await db.session.query('SELECT id FROM jobs')).rows).toHaveLength(0);
 expect(await tx(()=>requestQualification(ctx(),{candidateId:f.candidateId,expectedRevision:2}))).toMatchObject({reason:'retained_only'});
 expect(await tx(()=>requestSourceCheck(ctx(),{id:f.candidateId,expectedRevision:2}))).toMatchObject({reason:'retained_only'});
 const fetchPages=vi.fn(()=>{throw Error('Unexpected acquisition');});
 await tx(()=>runSourceCheck(ctx(),{candidateId:f.candidateId,checkId:randomUUID()},{providerKey:'controlled',fetchPages}));
 await runQualification(ctx(),{runId:interpreted.value.runId},{pageFetch:{providerKey:'controlled',fetchPages},extraction:null});expect(fetchPages).not.toHaveBeenCalled();
 expect(await tx(()=>enqueueFirmResearch(ctx(),{firmId:admitted.value.firmId,trigger:'user_request',requestedByUserId:seed.alpha.admin.userId}))).toMatchObject({reason:'research_disabled'});
 expect(await selectFirmsForSweep(ctx(),{limit:50,at:await retainedWallNow(ctx())})).not.toContainEqual({firmId:admitted.value.firmId});
 const target=randomUUID();await db.session.query("INSERT INTO firms(workspace_id,id,name,assigned_user_id) VALUES($1,$2,'Other controlled PM',$3)",[seed.alpha.workspaceId,target,seed.alpha.admin.userId]);
 expect(await tx(()=>mergeFirms(ctx(),{sourceFirmId:admitted.value.firmId,targetFirmId:target,journal:recordingSuppressionJournal()}))).toMatchObject({reason:'invalid_input'});expect(await retainedFirmOnly(ctx(),admitted.value.firmId)).toBe(true);
 await tx(()=>reviewCandidate(ctx(),{id:f.candidateId,expectedRevision:2,status:'kept'}));
 expect(await tx(()=>requestQualification(ctx(),{candidateId:f.candidateId,expectedRevision:3}))).toMatchObject({reason:'retained_only'});
 await tx(()=>deleteCandidate(ctx(),{id:f.candidateId,expectedRevision:3}));expect(await retainedFirmOnly(ctx(),admitted.value.firmId)).toBe(true);
});
