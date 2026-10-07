import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createTestDatabase,type TestDatabase} from '@fss/domain/db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '@fss/domain/test/db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {listFirmsForActor} from '@fss/domain/crm/dto.ts';
import {admitAutomaticEmailProspect} from '../src/handlers/emailAdmission.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {saveCandidate} from '@fss/domain/sourcing/candidates.ts';
import {requestQualification,finishQualification} from '@fss/domain/sourcing/qualificationStore.ts';
import {evaluateQualification} from '@fss/domain/sourcing/qualificationDecision.ts';
import {seedSequences} from '@fss/domain/test/sequences/support/sequenceFixtures.ts';
import {setProspectingAuthorization} from '@fss/domain/outreach/authorization.ts';
import {saveEmailAdmissionControl,readEmailAdmissionControl} from '@fss/domain/outreach/emailControl.ts';
import {readOutreachPlan} from '@fss/domain/outreach/plans.ts';
import {readEnrollment,listEnrollments,listStepExecutions} from '@fss/domain/sequences/rows.ts';
import {listContacts} from '@fss/domain/crm/contacts.ts';
import {listRoutes} from '@fss/domain/crm/routes.ts';
let db:TestDatabase;let seeded:TwoWorkspaces;let mailboxId:string;let sequenceId:string;
const admin=()=>repositoryContext(workspaceScope(seeded.alpha.workspaceId,{kind:'user',userId:seeded.alpha.admin.userId,role:'admin'}),db.session);
const tx=<T>(fn:()=>Promise<T>)=>withTransaction(db.session,fn);
async function configureFutureActivation(){
 vi.stubEnv('FSS_BUILD_COMMIT','a'.repeat(40));
 const sequences=await seedSequences(db.session,seeded);
 mailboxId=(await db.session.query<{id:string}>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status,sync_state,coverage_watermark_at,history_id,history_id_updated_at,baseline_completed_at,baseline_from_at) VALUES($1,$2,'owner@example.test','owner-fixture','connected','ready',clock_timestamp(),'123',clock_timestamp(),clock_timestamp(),clock_timestamp()-interval '1 day') RETURNING id",[seeded.alpha.workspaceId,seeded.alpha.admin.userId])).rows[0]!.id;
 await db.session.query('INSERT INTO mailbox_send_ramp(workspace_id,mailbox_id) VALUES($1,$2)',[seeded.alpha.workspaceId,mailboxId]);
 await db.session.query("INSERT INTO sending_domains(workspace_id,domain,is_primary,spf_pass,dkim_pass,dmarc_pass,automated_sending_enabled,automated_sending_enabled_at,authentication_checked_at,authentication_checked_by_user_id,postmaster_reviewed_at) VALUES($1,'example.test',true,true,true,true,true,now(),now(),$2,now())",[seeded.alpha.workspaceId,seeded.alpha.admin.userId]);
 await tx(()=>setProspectingAuthorization(admin(),{mailboxId,expectedRevision:0,enabled:true,basis:'owner_reported_google_permission'}));
 const seq=(await db.session.query<{id:string}>('INSERT INTO sequences(workspace_id,name,created_by_user_id) VALUES($1,$2,$3) RETURNING id',[seeded.alpha.workspaceId,'Reusable email',seeded.alpha.admin.userId])).rows[0]!.id;
 sequenceId=(await db.session.query<{id:string}>('INSERT INTO sequence_versions(workspace_id,sequence_id,version) VALUES($1,$2,1) RETURNING id',[seeded.alpha.workspaceId,seq])).rows[0]!.id;
 for(let i=0;i<5;i++)await db.session.query("INSERT INTO sequence_steps(workspace_id,sequence_version_id,ordinal,channel,delay_unit,delay_amount,template_version_id) VALUES($1,$2,$3,'email','elapsed',0,$4)",[seeded.alpha.workspaceId,sequenceId,i+1,sequences.alpha.template.templateVersionId]);
 await db.session.query("UPDATE sequence_versions SET state='published',published_at=now(),published_by_user_id=$2 WHERE id=$1",[sequenceId,seeded.alpha.admin.userId]);
 const config={enabled:false,ownerUserId:seeded.alpha.admin.userId,mailboxId,sequenceVersionId:sequenceId,evaluation:null};
 expect(await tx(()=>saveEmailAdmissionControl(admin(),{...config,expectedRevision:0}))).toMatchObject({ok:true});
 const control=await readEmailAdmissionControl(admin());
 const evaluation={policyVersion:'outreach-email-fit-v1',promptVersion:'qualification-growth-v6',implementationCommit:'a'.repeat(40),configurationSha256:control.configurationSha256,reportSha256:'b'.repeat(64),reviewedEligible:20,falseEligible:0};
 expect(await tx(()=>saveEmailAdmissionControl(admin(),{...config,evaluation,expectedRevision:1}))).toMatchObject({ok:true});
 // Simulate a later, explicitly gated activation ONLY in this disposable database.
 // The shipped migration and all application activation controls remain disabled.
 await db.session.query('ALTER TABLE outreach_email_admission_settings DROP CONSTRAINT outreach_email_admission_settings_enabled_check');
 await db.session.query('UPDATE outreach_email_admission_settings SET enabled=true WHERE workspace_id=$1',[seeded.alpha.workspaceId]);
}
async function qualified(name:string,options:{need?:string;retrievedAt?:string;truncated?:boolean}={}){
 const website=`https://${name.toLowerCase().replaceAll(' ','')}.example.test/`;
 const candidate=await tx(()=>saveCandidate(admin(),{firmName:name,website,locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Residential management',sourceUrl:website,observedOn:new Date().toISOString().slice(0,10),preparedBy:'Fixture'}));if(!candidate.ok)throw new Error(candidate.reason);
 const request=await tx(()=>requestQualification(admin(),{candidateId:candidate.value.id,expectedRevision:1}));if(!request.ok)throw new Error(request.reason);
 const id=randomUUID(),blocks=[{id:'firm',text:`${name} is a residential property management company in Dallas, Texas.`},{id:'email',text:`${name} Dallas TX office info@${new URL(website).hostname}`}];
 if(options.need)blocks.push({id:'need',text:options.need});
 const facts=[['firm_identity','firm'],['residential_management','firm'],['service_area','firm'],['business_email','email']].map(([kind,blockId])=>({kind,blockId,observationId:id,value:blocks.find(b=>b.id===blockId)!.text}));
 if(options.need)facts.push({kind:'operational_burden',blockId:'need',observationId:id,value:options.need});
 const finished=await tx(()=>finishQualification(admin(),{runId:request.value.runId,reason:null,observations:[{id,url:website,contentHash:'c'.repeat(64),relevantTextHash:'d'.repeat(64),retrievedAt:options.retrievedAt??new Date().toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:options.truncated??false,blocks}],facts}));if(!finished.ok)throw new Error(finished.reason);
 await tx(()=>evaluateQualification(admin(),{runId:request.value.runId}));
 return {candidateId:candidate.value.id,qualificationRunId:request.value.runId,expectedRevision:1,expectedControlRevision:2};
}
const worker=()=>repositoryContext(workspaceScope(seeded.alpha.workspaceId,{kind:'system',component:'worker'}),db.session);
beforeEach(async()=>{db=await createTestDatabase();seeded=await seedTwoWorkspaces(db.session);});
afterEach(async()=>{vi.unstubAllEnvs();await db.drop();});
it('does not create a prospect when automatic email admission is off',async()=>{
 const before=await listFirmsForActor(worker());
 expect(await admitAutomaticEmailProspect(worker(),{candidateId:randomUUID(),qualificationRunId:randomUUID(),expectedRevision:1,expectedControlRevision:0})).toEqual({ok:false,reason:'automatic_email_disabled'});
 expect(await listFirmsForActor(worker())).toEqual(before);
});

it('admits verified email fit without phone or public pain, and schedules only the reusable email sequence',async()=>{
 await configureFutureActivation();
 const input=await qualified('Verified Fit PM');
 const runtime=repositoryContext(worker().scope,await db.appRuntimeSession());
 const result=await admitAutomaticEmailProspect(runtime,input);
 expect(result,JSON.stringify(result)).toMatchObject({ok:true});
 if(!result.ok)throw new Error(result.reason);
 expect(await readOutreachPlan(worker(),result.value.planId)).toMatchObject({lane:'email_first',state:'active',ownerUserId:seeded.alpha.admin.userId,mailboxId});
 expect(await readEnrollment(worker(),{enrollmentId:result.value.enrollmentId})).toMatchObject({sequenceVersionId:sequenceId,opportunityId:null,outreachPlanId:result.value.planId});
 expect(await listContacts(worker(),result.value.firmId)).toMatchObject([{full_name:'Office'}]);
 expect(await listRoutes(worker(),'email',result.value.firmId)).toMatchObject([{technical_validation:'unknown'}]);
 expect(await listStepExecutions(worker(),{enrollmentId:result.value.enrollmentId})).toMatchObject([{channel:'email',state:'pending',sourceZone:'America/Chicago',attemptCount:0}]);
 expect(await listEnrollments(worker(),{firmId:result.value.firmId})).toHaveLength(1);
});
it('refuses an older qualification even when its candidate revision still matches',async()=>{
 await configureFutureActivation();const input=await qualified('Latest Evidence PM');
 await db.session.query(`INSERT INTO sourcing_qualification_runs(workspace_id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name,requested_at)
 SELECT workspace_id,candidate_id,candidate_revision,$2,prompt_version,policy_version,model_name,requested_at+interval '1 second' FROM sourcing_qualification_runs WHERE id=$1`,[input.qualificationRunId,'e'.repeat(64)]);
 const before=await listFirmsForActor(worker());
 expect(await admitAutomaticEmailProspect(worker(),input)).toEqual({ok:false,reason:'qualification_changed'});
 expect(await listFirmsForActor(worker())).toEqual(before);
});
it('refuses new admission when the sender ramp has no room',async()=>{
 await configureFutureActivation();const input=await qualified('Capacity PM');
 await db.session.query('UPDATE mailbox_send_ramp SET admin_daily_cap=0,admin_changed_at=now(),admin_changed_by_user_id=$2 WHERE mailbox_id=$1',[mailboxId,seeded.alpha.admin.userId]);
 const before=await listFirmsForActor(worker());
 expect(await admitAutomaticEmailProspect(worker(),input)).toEqual({ok:false,reason:'mailbox_capacity_exhausted'});
 expect(await listFirmsForActor(worker())).toEqual(before);
});
it('leaves sender capacity for already queued first touches before admitting another firm',async()=>{
 await configureFutureActivation();
 await db.session.query('UPDATE mailbox_send_ramp SET admin_daily_cap=1,admin_changed_at=now(),admin_changed_by_user_id=$2 WHERE mailbox_id=$1',[mailboxId,seeded.alpha.admin.userId]);
 const first=await qualified('Queued First PM');expect(await admitAutomaticEmailProspect(worker(),first)).toMatchObject({ok:true});
 const next=await qualified('Next First PM'),before=await listFirmsForActor(worker());
 expect(await admitAutomaticEmailProspect(worker(),next)).toEqual({ok:false,reason:'mailbox_capacity_exhausted'});
 expect(await listFirmsForActor(worker())).toEqual(before);
 expect(await listEnrollments(worker())).toHaveLength(1);
});
it('holds new admission when mailbox coverage is stale',async()=>{
 await configureFutureActivation();const input=await qualified('Unseen Replies PM');
 await db.session.query("UPDATE mailboxes SET coverage_watermark_at=clock_timestamp()-interval '20 minutes' WHERE id=$1",[mailboxId]);
 const before=await listFirmsForActor(worker());
 expect(await admitAutomaticEmailProspect(worker(),input)).toEqual({ok:false,reason:'sender_unhealthy'});
 expect(await listFirmsForActor(worker())).toEqual(before);
});
it('disables new admissions without cancelling an already scheduled enrollment',async()=>{
 await configureFutureActivation();const first=await qualified('Before Disable PM');
 const admitted=await admitAutomaticEmailProspect(worker(),first);if(!admitted.ok)throw new Error(admitted.reason);
 const enrollment=await readEnrollment(worker(),{enrollmentId:admitted.value.enrollmentId});
 expect(await tx(()=>saveEmailAdmissionControl(admin(),{enabled:false,ownerUserId:seeded.alpha.admin.userId,mailboxId,sequenceVersionId:sequenceId,evaluation:null,expectedRevision:2}))).toMatchObject({ok:true});
 expect(await admitAutomaticEmailProspect(worker(),await qualified('After Disable PM'))).toEqual({ok:false,reason:'automatic_email_disabled'});
 expect(await readEnrollment(worker(),{enrollmentId:admitted.value.enrollmentId})).toEqual(enrollment);
});
it('rolls back the entire prospect when enrollment storage fails, then permits a clean retry',async()=>{
 await configureFutureActivation();const input=await qualified('Atomic Retry PM');
 const before=await listFirmsForActor(worker()),enrollments=await listEnrollments(worker());
 // Inject an external database failure at the last write, without mocking domain collaborators.
 await db.session.query("CREATE FUNCTION reject_test_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test_enrollment_failure'; END $$");
 await db.session.query('CREATE TRIGGER reject_test_enrollment BEFORE INSERT ON sequence_enrollments FOR EACH ROW EXECUTE FUNCTION reject_test_enrollment()');
 await expect(admitAutomaticEmailProspect(worker(),input)).rejects.toThrow('test_enrollment_failure');
 expect(await listFirmsForActor(worker())).toEqual(before);expect(await listEnrollments(worker())).toEqual(enrollments);
 await db.session.query('DROP TRIGGER reject_test_enrollment ON sequence_enrollments');
 const retried=await admitAutomaticEmailProspect(worker(),input);expect(retried).toMatchObject({ok:true});
 if(!retried.ok)throw new Error(retried.reason);
 const {readFirmSourcing}=await import('@fss/domain/sourcing/attribution.ts');
 expect(await readFirmSourcing(worker(),retried.value.firmId)).toMatchObject({sources:[{candidateId:input.candidateId,qualificationRunId:input.qualificationRunId,policyVersion:'outreach-email-fit-v1',hypothesis:'fit_only',sourceAvailable:true}]});
});
it('concurrent workers and later retries preserve one enrollment and its original scheduled execution',async()=>{
 await configureFutureActivation();const input=await qualified('Key Properties Fixture');
 const second=repositoryContext(worker().scope,await db.appRuntimeSession());
 const results=await Promise.all([admitAutomaticEmailProspect(worker(),input),admitAutomaticEmailProspect(second,input)]);
 expect(results.filter(r=>r.ok)).toHaveLength(1);
 const success=results.find(r=>r.ok);if(!success?.ok)throw new Error('no_admission');
 const original=await readEnrollment(worker(),{enrollmentId:success.value.enrollmentId});
 const steps=await listStepExecutions(worker(),{enrollmentId:success.value.enrollmentId});
 expect(await admitAutomaticEmailProspect(worker(),input)).toMatchObject({ok:false});
 expect(await listEnrollments(worker(),{firmId:success.value.firmId})).toEqual([original]);
 expect(await listStepExecutions(worker(),{enrollmentId:success.value.enrollmentId})).toEqual(steps);
});
it('sees a concurrent recipient stop committed while the worker waits for the send gate',async()=>{
 await configureFutureActivation();const input=await qualified('Concurrent Stop PM');
 const session=await db.appRuntimeSession(),other=repositoryContext(worker().scope,session);
 const pid=(await session.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
 const {recordSuppression}=await import('@fss/domain/suppression/events.ts');
 const {recordingSuppressionJournal}=await import('@fss/domain/suppression/journal.ts');
 await db.session.query('BEGIN');
 try{
  expect(await recordSuppression(admin(),{scope:'handle',value:'info@concurrentstoppm.example.test',channel:'email',source:'prospect_opt_out',journal:recordingSuppressionJournal()})).toMatchObject({ok:true});
  const attempt=admitAutomaticEmailProspect(other,input);
  await expect.poll(async()=>(await db.session.query<{wait_event_type:string}>('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.wait_event_type,{timeout:2000}).toBe('Lock');
  await db.session.query('COMMIT');
  expect(await attempt).toEqual({ok:false,reason:'email_or_firm_stopped'});
 }finally{await db.session.query('ROLLBACK');}
 expect(await listEnrollments(worker())).toHaveLength(0);
 expect((await listFirmsForActor(worker())).some(f=>f.name==='Concurrent Stop PM')).toBe(false);
});
it('rejects a changed exact-version evaluation without partial admission',async()=>{
 await configureFutureActivation();const input=await qualified('Changed Evaluation PM'),before=await listFirmsForActor(worker());
 vi.stubEnv('FSS_BUILD_COMMIT','f'.repeat(40));
 expect(await admitAutomaticEmailProspect(worker(),input)).toEqual({ok:false,reason:'evaluation_mismatch'});
 expect(await listFirmsForActor(worker())).toEqual(before);expect(await listEnrollments(worker())).toHaveLength(0);
});
it('rejects revoked and reauthorized mailbox bindings until reevaluation',async()=>{
 await configureFutureActivation();const input=await qualified('Reauthorized PM'),before=await listFirmsForActor(worker());
 await tx(()=>setProspectingAuthorization(admin(),{mailboxId,expectedRevision:1,enabled:false,basis:'owner_reported_google_permission'}));
 expect(await admitAutomaticEmailProspect(worker(),input)).toEqual({ok:false,reason:'mailbox_not_authorized'});
 await tx(()=>setProspectingAuthorization(admin(),{mailboxId,expectedRevision:2,enabled:true,basis:'owner_reported_google_permission'}));
 expect(await admitAutomaticEmailProspect(worker(),input)).toEqual({ok:false,reason:'mailbox_binding_changed'});
 expect(await listFirmsForActor(worker())).toEqual(before);
});
it('does not fill unused capacity after a recorded provider warning',async()=>{
 await configureFutureActivation();const input=await qualified('Provider Warning PM');
 const {openSendDay,recordDaySignal}=await import('@fss/domain/outbound/ramp.ts');
 const {workspaceBusinessZone}=await import('@fss/domain/research/ledger.ts');
 const {localDate}=await import('@fss/domain/src/rules/localClock.ts');
 const businessDate=localDate(new Date().toISOString(),await workspaceBusinessZone(worker()));
 await openSendDay(worker(),{mailboxId,businessDate,cap:5});
 await recordDaySignal(worker(),{mailboxId,businessDate,signal:'provider_error'});
 const before=await listFirmsForActor(worker());
 expect(await admitAutomaticEmailProspect(worker(),input)).toEqual({ok:false,reason:'sender_unhealthy'});
 expect(await listFirmsForActor(worker())).toEqual(before);
});
it('defers an unattributed CRM email instead of treating it as human-reviewed',async()=>{
 await configureFutureActivation();const input=await qualified('Existing Office PM');
 const {createFirm}=await import('@fss/domain/crm/firms.ts');
 const {createContact}=await import('@fss/domain/crm/contacts.ts');
 const {addEmailRoute,recordEmailRouteValidation}=await import('@fss/domain/crm/routes.ts');
 const firm=await tx(()=>createFirm(admin(),{name:'Existing Office PM',website:'https://existingofficepm.example.test/',locality:'Dallas',regionCode:'TX',assignedUserId:seeded.alpha.admin.userId}));if(!firm.ok)throw new Error(firm.reason);
 const contact=await tx(()=>createContact(admin(),{firmId:firm.value.id,fullName:'Existing Office'}));if(!contact.ok)throw new Error(contact.reason);
 const route=await tx(()=>addEmailRoute(admin(),{firmId:firm.value.id,contactId:contact.value.id,address:'info@existingofficepm.example.test',source:'website',retrievedAt:new Date(),associationConfidence:1}));if(!route.ok)throw new Error(route.reason);
 await tx(()=>recordEmailRouteValidation(admin(),{routeId:route.value.id,routeVersion:1,technicalValidation:'passed',vouchedConfidence:null,detail:{fixture:true}}));
 const contacts=await listContacts(worker(),firm.value.id),routes=await listRoutes(worker(),'email',firm.value.id);
 expect(await admitAutomaticEmailProspect(worker(),input)).toEqual({ok:false,reason:'email_association_unattributed'});
 expect(await listContacts(worker(),firm.value.id)).toEqual(contacts);expect(await listRoutes(worker(),'email',firm.value.id)).toEqual(routes);
 expect(await listEnrollments(worker())).toHaveLength(0);
});

it('retains freshness and complete first-party evidence requirements',async()=>{
 await configureFutureActivation();const input=await qualified('Expired Evidence PM',{retrievedAt:new Date(Date.now()-8*86400000).toISOString()});
 const before=await listFirmsForActor(worker());
 expect(await admitAutomaticEmailProspect(worker(),input)).toMatchObject({ok:false});
 expect(await listFirmsForActor(worker())).toEqual(before);expect(await listEnrollments(worker())).toHaveLength(0);
});
it('defers explicit contrary need evidence despite a supported business email',async()=>{
 await configureFutureActivation();const input=await qualified('Contrary Need PM',{need:'We do not need maintenance help.'});
 const before=await listFirmsForActor(worker());
 expect(await admitAutomaticEmailProspect(worker(),input)).toEqual({ok:false,reason:'need_evidence_conflicts'});
 expect(await listFirmsForActor(worker())).toEqual(before);expect(await listEnrollments(worker())).toHaveLength(0);
});
it('requires the worker capability and does not grant admission to ordinary administrator or scheduler calls',async()=>{
 await configureFutureActivation();const input=await qualified('Scoped Authority PM');
 expect(await admitAutomaticEmailProspect(admin(),input)).toEqual({ok:false,reason:'automatic_email_capability_required'});
 const scheduler=repositoryContext(workspaceScope(seeded.alpha.workspaceId,{kind:'system',component:'scheduler'}),db.session);
 expect(await admitAutomaticEmailProspect(scheduler,input)).toEqual({ok:false,reason:'automatic_email_capability_required'});
 const unrelated=repositoryContext(workspaceScope(seeded.beta.workspaceId,{kind:'system',component:'worker'}),db.session);
 expect(await admitAutomaticEmailProspect(unrelated,input)).toEqual({ok:false,reason:'automatic_email_disabled'});
 expect(await listEnrollments(worker())).toHaveLength(0);
});
it('preserves the original manually enrolled Key prospect without rearming or enrolling it again',async()=>{
 await configureFutureActivation();const input=await qualified('Original Key Fixture');
 const {previewOutreachCohort,enableOutreachCohort}=await import('@fss/domain/outreach/cohorts.ts');
 const cohort={mailboxId,candidateIds:[input.candidateId],emailSequenceVersionId:sequenceId,callSequenceVersionId:null};
 const preview=await previewOutreachCohort(admin(),cohort);if(!preview.ok)throw new Error(preview.reason);
 const admitted=await tx(()=>enableOutreachCohort(admin(),{...cohort,expectedHash:preview.value.hash,reviewed:true}));if(!admitted.ok)throw new Error(admitted.reason);
 const original=await listEnrollments(worker());expect(original).toHaveLength(1);
 const steps=await listStepExecutions(worker(),{enrollmentId:original[0]!.id});
 expect(await admitAutomaticEmailProspect(worker(),input)).toEqual({ok:false,reason:'firm_already_enrolled'});
 expect(await listEnrollments(worker())).toEqual(original);expect(await listStepExecutions(worker(),{enrollmentId:original[0]!.id})).toEqual(steps);
});
it('defers a held firm before creating any contact or enrollment',async()=>{
 await configureFutureActivation();const input=await qualified('Held Office PM');
 const {createFirm}=await import('@fss/domain/crm/firms.ts');const {openHold}=await import('@fss/domain/policy/holds.ts');
 const firm=await tx(()=>createFirm(admin(),{name:'Held Office PM',website:'https://heldofficepm.example.test/',locality:'Dallas',regionCode:'TX',assignedUserId:seeded.alpha.admin.userId}));if(!firm.ok)throw new Error(firm.reason);
 await tx(()=>openHold(admin(),{scopeKind:'firm',scopeKey:firm.value.id,reasonCode:'uncertain_reply',blockedActionKinds:['email_send'],sourceEventKind:'fixture'}));
 expect(await admitAutomaticEmailProspect(worker(),input)).toEqual({ok:false,reason:'prospect_held'});
 expect(await listContacts(worker(),firm.value.id)).toHaveLength(0);expect(await listEnrollments(worker())).toHaveLength(0);
});
it('does not reassign a supported firm owned by someone else',async()=>{
 await configureFutureActivation();const input=await qualified('Other Owner PM');
 const {createFirm,readFirm}=await import('@fss/domain/crm/firms.ts');
 const firm=await tx(()=>createFirm(admin(),{name:'Other Owner PM',website:'https://otherownerpm.example.test/',locality:'Dallas',regionCode:'TX',assignedUserId:seeded.alpha.salesperson.userId}));if(!firm.ok)throw new Error(firm.reason);
 const before=await readFirm(worker(),firm.value.id);
 expect(await admitAutomaticEmailProspect(worker(),input)).toEqual({ok:false,reason:'firm_changed'});
 expect(await readFirm(worker(),firm.value.id)).toEqual(before);expect(await listContacts(worker(),firm.value.id)).toHaveLength(0);
});
it('refuses a retired evaluated sequence',async()=>{
 await configureFutureActivation();const input=await qualified('Changed Sequence PM'),before=await listFirmsForActor(worker());
 const {retireVersion}=await import('@fss/domain/sequences/definitions.ts');
 expect(await tx(()=>retireVersion(admin(),{sequenceVersionId:sequenceId}))).toMatchObject({ok:true});
 expect(await admitAutomaticEmailProspect(worker(),input)).toEqual({ok:false,reason:'approved_email_sequence_required'});
 expect(await listFirmsForActor(worker())).toEqual(before);expect(await listEnrollments(worker())).toHaveLength(0);
});
it('serializes sequence retirement with admission through the entire enrollment write',async()=>{
 await configureFutureActivation();const input=await qualified('Sequence Race PM');
 const workerSession=await db.appRuntimeSession(),retireSession=await db.appRuntimeSession();
 const runtime=repositoryContext(worker().scope,workerSession),retiringAdmin=repositoryContext(admin().scope,retireSession);
 const workerPid=(await workerSession.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
 const retirePid=(await retireSession.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
 await db.session.query('SELECT pg_advisory_lock(420)');
 await db.session.query('CREATE FUNCTION wait_test_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(420); RETURN NEW; END $$');
 await db.session.query('CREATE TRIGGER wait_test_enrollment BEFORE INSERT ON sequence_enrollments FOR EACH ROW EXECUTE FUNCTION wait_test_enrollment()');
 const admission=admitAutomaticEmailProspect(runtime,input);
 const {retireVersion}=await import('@fss/domain/sequences/definitions.ts');
 let retirement:ReturnType<typeof retireVersion>|undefined;
 try{
  await expect.poll(async()=>(await db.session.query<{waiting:boolean}>('SELECT $2=ANY(pg_blocking_pids($1)) AS waiting',[workerPid,(await db.session.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid])).rows[0]?.waiting,{timeout:2000}).toBe(true);
  retirement=withTransaction(retireSession,()=>retireVersion(retiringAdmin,{sequenceVersionId:sequenceId}));
  await expect.poll(async()=>(await db.session.query<{waiting:boolean}>('SELECT $2=ANY(pg_blocking_pids($1)) AS waiting',[retirePid,workerPid])).rows[0]?.waiting,{timeout:2000}).toBe(true);
 }finally{await db.session.query('SELECT pg_advisory_unlock(420)');await Promise.allSettled([admission,...(retirement?[retirement]:[])]);}
 expect(await admission).toMatchObject({ok:true});expect(await retirement).toMatchObject({ok:true});
 expect(await listEnrollments(worker())).toHaveLength(1);
});
