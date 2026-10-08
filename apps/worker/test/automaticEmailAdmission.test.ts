import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createTestDatabase,type TestDatabase} from '@fss/domain/db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '@fss/domain/test/db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {listFirmsForActor} from '@fss/domain/crm/dto.ts';
import {admitAutomaticEmailProspect,runAutomaticEmailBatch} from '../src/handlers/emailAdmission.ts';
import {withTransaction,type QueryResultRowLike} from '@fss/domain/db/queryable.ts';
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
async function qualified(name:string,options:{need?:string;needKind?:string;publishedAt?:string|null;retrievedAt?:string;truncated?:boolean;phone?:boolean;named?:boolean}={}){
 const website=`https://${name.toLowerCase().replaceAll(' ','')}.example.test/`;
 const candidate=await tx(()=>saveCandidate(admin(),{firmName:name,website,locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Residential management',sourceUrl:website,observedOn:new Date().toISOString().slice(0,10),preparedBy:'Fixture'}));if(!candidate.ok)throw new Error(candidate.reason);
 const request=await tx(()=>requestQualification(admin(),{candidateId:candidate.value.id,expectedRevision:1}));if(!request.ok)throw new Error(request.reason);
 const id=randomUUID(),blocks=[{id:'firm',text:`${name} is a residential property management company in Dallas, Texas.`},{id:'email',text:`${name} Dallas TX ${options.named?'contact Jane Smith at jane@':'office info@'}${new URL(website).hostname}`}];
 if(options.phone)blocks.push({id:'phone',text:`${name} Dallas TX office (214) 555-0100`});
 if(options.need)blocks.push({id:'need',text:options.need+(options.publishedAt?' Published '+options.publishedAt.slice(0,10):'')});
 const facts=[['firm_identity','firm'],['residential_management','firm'],['service_area','firm'],['business_email','email']].map(([kind,blockId])=>({kind,blockId,observationId:id,value:blocks.find(b=>b.id===blockId)!.text}));
 if(options.phone)facts.push({kind:'business_phone',blockId:'phone',observationId:id,value:blocks.find(b=>b.id==='phone')!.text});
 if(options.need)facts.push({kind:options.needKind??'operational_burden',blockId:'need',observationId:id,value:options.need});
 const finished=await tx(()=>finishQualification(admin(),{runId:request.value.runId,reason:null,observations:[{id,url:website,contentHash:'c'.repeat(64),relevantTextHash:'d'.repeat(64),retrievedAt:options.retrievedAt??new Date().toISOString(),publishedAt:options.publishedAt??null,publishedAtBlockId:options.publishedAt?'need':null,firstParty:true,truncated:options.truncated??false,blocks}],facts}));if(!finished.ok)throw new Error(finished.reason);
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

it('runs no automatic batch while activation is disabled',async()=>{
 const before=await listFirmsForActor(worker());
 expect(await runAutomaticEmailBatch(worker(),0)).toMatchObject({reason:'automatic_email_disabled',admitted:[]});
 expect(await listFirmsForActor(worker())).toEqual(before);
});
it('ranks email fit before spending the last slot, including call-review prospects',async()=>{
 await configureFutureActivation();
 await db.session.query('UPDATE mailbox_send_ramp SET admin_daily_cap=1,admin_changed_at=now(),admin_changed_by_user_id=$2 WHERE mailbox_id=$1',[mailboxId,seeded.alpha.admin.userId]);
 await qualified('A Fit Office');
 const burden=await qualified('Z Burden Office',{need:'Our maintenance team is overwhelmed by work orders and vendor follow-up.'});
 const batch=await runAutomaticEmailBatch(worker(),2);
 expect(batch.admitted).toMatchObject([{candidateId:burden.candidateId}]);
 expect(batch.reason).toBe('mailbox_capacity_exhausted');
 expect(await listEnrollments(worker())).toHaveLength(1);
});
it('does not keep retrying permanent uncertainty on unchanged evidence',async()=>{
 await configureFutureActivation();await qualified('Contrary Batch',{need:'We do not need maintenance help.'});
 const first=await runAutomaticEmailBatch(worker(),2);
 expect(first).toMatchObject({checked:1,deferred:[{reason:'need_evidence_conflicts'}],admitted:[]});
 expect(await runAutomaticEmailBatch(worker(),2)).toMatchObject({checked:0,admitted:[]});
});
it('schedules one workspace batch on repeated passes and runs it without a research provider',async()=>{
 await configureFutureActivation();const prospect=await qualified('Scheduled Review Fit');
 const {runSchedulerPass}=await import('../src/scheduler/schedulerPass.ts');
 const {automaticEmailSource}=await import('../src/handlers/emailAdmission.ts');
 const {HandlerRegistry}=await import('@fss/domain/jobs/handlerRegistry.ts');
 const {registerHandlers}=await import('../src/bootstrap/main.ts');
 const {runOnce}=await import('../src/runner/jobRunner.ts');
 const now=new Date().toISOString();
 const options={sources:[automaticEmailSource()],now};
 expect(await runSchedulerPass(db.session,options)).toMatchObject({inserted:1,externalActions:0});
 expect(await runSchedulerPass(db.session,options)).toMatchObject({inserted:0,externalActions:0});
 const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined});
 expect(await runOnce(db.session,{registry,owner:'email-test',classes:['bulk'],limit:1})).toMatchObject({completed:1});
 expect(await listEnrollments(worker())).toHaveLength(1);
 expect((await runAutomaticEmailBatch(worker(),2)).admitted).toEqual([]);
 expect(prospect.candidateId).toBeTruthy();
});
it('does not build a second batch behind a queued or retryable worker job',async()=>{
 await configureFutureActivation();await qualified('Pending Batch Fit');
 const {runSchedulerPass}=await import('../src/scheduler/schedulerPass.ts');
 const {automaticEmailSource}=await import('../src/handlers/emailAdmission.ts');
 const now=new Date().toISOString();
 expect(await runSchedulerPass(db.session,{sources:[automaticEmailSource()],now})).toMatchObject({inserted:1});
 const later=new Date(Date.now()+2*3600000).toISOString();
 expect(await runSchedulerPass(db.session,{sources:[automaticEmailSource()],now:later})).toMatchObject({inserted:0});
});
it.each([null,new Date(Date.now()-100*86400000).toISOString()])('downgrades unknown or expired help dates before ranking despite a supported phone (%s)',async publishedAt=>{
 await configureFutureActivation();
 await qualified('A Undated Help',{need:'We need help with maintenance coordination.',needKind:'help_request',phone:true,publishedAt});
 const burden=await qualified('Z Current Burden',{need:'Our maintenance team is overwhelmed by work orders.'});
 await db.session.query('UPDATE mailbox_send_ramp SET admin_daily_cap=1,admin_changed_at=now(),admin_changed_by_user_id=$2 WHERE mailbox_id=$1',[mailboxId,seeded.alpha.admin.userId]);
 expect((await runAutomaticEmailBatch(worker(),2)).admitted).toMatchObject([{candidateId:burden.candidateId}]);
});
it('bounds temporary refusal checks and permits recovery when the hold is released',async()=>{
 await configureFutureActivation();const prospect=await qualified('Held Batch Office');
 const {openHold,releaseHold}=await import('@fss/domain/policy/holds.ts');
 const hold=await tx(()=>openHold(worker(),{scopeKind:'workspace',reasonCode:'scoped_pause',blockedActionKinds:['email_send'],sourceEventKind:'administrative_pause'}));
 expect(await runAutomaticEmailBatch(worker(),2)).toMatchObject({checked:1,reason:'sender_unhealthy',admitted:[]});
 expect(await runAutomaticEmailBatch(worker(),2)).toMatchObject({checked:0,admitted:[]});
 await tx(()=>releaseHold(worker(),hold));
 await db.session.query("UPDATE sourcing_qualification_runs SET email_admission_next_at=now()-interval '1 minute' WHERE id=$1",[prospect.qualificationRunId]);
 expect((await runAutomaticEmailBatch(worker(),2)).admitted).toMatchObject([{candidateId:prospect.candidateId}]);
});

async function preparedAutomaticSender(){
 await configureFutureActivation();const input=await qualified('Sender Office PM');
 const result=await admitAutomaticEmailProspect(worker(),input);if(!result.ok)throw new Error(result.reason);
 const {recordEmailRouteValidation}=await import('@fss/domain/crm/routes.ts');
 await tx(()=>recordEmailRouteValidation(admin(),{routeId:result.value.routeId,routeVersion:1,technicalValidation:'passed',vouchedConfidence:null,detail:{fixture:true}}));
 const [step]=await listStepExecutions(worker(),{enrollmentId:result.value.enrollmentId});if(!step)throw new Error('missing step');
 const at=new Date(Date.parse(step.dueAt)+60000).toISOString();
 const {storeFixtureCiGateRecord,FIXTURE_WORKER_DIGEST,FIXTURE_CI_COMMIT}=await import('@fss/domain/test/release/support/releaseRecords.ts');
 const {ciGateReleaseReference}=await import('@fss/contracts');
 await storeFixtureCiGateRecord(db.session,'41000000921');
 await db.session.query("INSERT INTO workspace_settings(workspace_id,setting_key,version,value,change_note,changed_by_user_id) VALUES($1,'sending_enabled',1,$2::jsonb,'sender fixture',$3)",[seeded.alpha.workspaceId,JSON.stringify({enabled:true,releaseGateReference:ciGateReleaseReference('41000000921',FIXTURE_CI_COMMIT)}),seeded.alpha.admin.userId]);
 const {recordedGmailClient}=await import('@fss/domain/mail/gmailClientFake.ts');
 const {localEnvelopeCipher}=await import('@fss/domain/mail/envelope.ts');
 const {storeRefreshToken}=await import('@fss/domain/mail/tokens.ts');
 const {mailConfig}=await import('@fss/domain/test/mail/support/mailWorld.ts');
 const cipher=localEnvelopeCipher();
 await storeRefreshToken(worker(),{mailboxId,plaintext:randomUUID(),cipher});
 const gmail=recordedGmailClient({emailAddress:'owner@example.test',historyId:'123',messages:[]});
 const deps={gmail,cipher,oauth:{...mailConfig(),clientSecret:randomUUID()},deploymentSendingEnabled:true,workerImageDigest:FIXTURE_WORKER_DIGEST,now:()=>new Date(at)};
 const {outboundSendHandoff}=await import('../src/handlers/outboundSendHandoff.ts');
 const {runDueStepExecution}=await import('@fss/domain/sequences/executions.ts');
 const {composeEligibility}=await import('@fss/domain/sequences/eligibility.ts');
 // Freeze only the database clock query; every business query still uses the real session.
 const timed=repositoryContext(worker().scope,{query:async <Row extends QueryResultRowLike>(sql:string,values?:readonly unknown[])=>sql==='SELECT now() AS now'?{rows:[{now:new Date(at)} as unknown as Row],rowCount:1}:db.session.query<Row>(sql,values)});
 const prepared=await tx(()=>runDueStepExecution(timed,{stepExecutionId:step.id,now:at,eligibility:composeEligibility(),sendHandoff:outboundSendHandoff({deps})}));
 expect(prepared,JSON.stringify(prepared)).toMatchObject({kind:'handed_to_send'});
 if(prepared.kind!=='handed_to_send')throw new Error(prepared.kind);
 return {...input,...result.value,step,at,gmail,deps,timed,fenceId:prepared.outboundMessageId};
}
it('dispatches an automatically admitted enrollment once through the existing sender',async()=>{
 const f=await preparedAutomaticSender();
 const {dispatchOutboundMessage}=await import('@fss/domain/outbound/send.ts');
 const sent=await dispatchOutboundMessage(f.timed,f.deps,{outboundMessageId:f.fenceId});
 expect(sent,JSON.stringify(sent)).toMatchObject({outcome:'sent'});
 await dispatchOutboundMessage(f.timed,f.deps,{outboundMessageId:f.fenceId});
 expect(f.gmail.sends).toHaveLength(1);
});
it.each(['route','cap','sending_disabled'] as const)('rechecks %s at dispatch for an automatic enrollment and makes zero Gmail calls',async change=>{
 const f=await preparedAutomaticSender();
 if(change==='route'){
  const {verifyRoute}=await import('@fss/domain/crm/routes.ts');
  expect(await tx(()=>verifyRoute(admin(),{routeKind:'email',routeId:f.routeId,technicalValidation:'failed'}))).toMatchObject({ok:true});
 }else if(change==='cap')await db.session.query('UPDATE mailbox_send_ramp SET admin_daily_cap=0,admin_changed_at=now(),admin_changed_by_user_id=$2 WHERE mailbox_id=$1',[mailboxId,seeded.alpha.admin.userId]);
 else await db.session.query('UPDATE sending_domains SET automated_sending_enabled=false,automated_sending_enabled_at=NULL WHERE workspace_id=$1',[seeded.alpha.workspaceId]);
 const {dispatchOutboundMessage}=await import('@fss/domain/outbound/send.ts');
 const sent=await dispatchOutboundMessage(f.timed,f.deps,{outboundMessageId:f.fenceId});
 expect(sent,JSON.stringify(sent)).toMatchObject({outcome:'held',refusal:change==='route'?'route_invalid':change==='cap'?'daily_cap':'automated_sending_disabled'});
 expect(f.gmail.sends).toHaveLength(0);
});
it.each(['reply','booking','opt_out'] as const)('interrupts automatic enrollment on %s before dispatch, with zero Gmail calls',async change=>{
 const f=await preparedAutomaticSender();
 if(change==='booking'){
  const {receiveCalcomEvent}=await import('@fss/domain/meetings/calcom.ts');
  const body={triggerEvent:'BOOKING_CREATED',createdAt:new Date().toISOString(),payload:{uid:randomUUID(),startTime:f.at,endTime:new Date(Date.parse(f.at)+1800000).toISOString(),organizer:{email:'owner@example.test'},attendees:[{email:'info@senderofficepm.example.test',name:'Office'}]}};
  await tx(()=>receiveCalcomEvent(db.session,{workspaceId:seeded.alpha.workspaceId,rawBody:Buffer.from(JSON.stringify(body)),body}));
  expect(await readOutreachPlan(worker(),f.planId)).toMatchObject({state:'booked'});
 }else{
  const {recordMessage}=await import('@fss/domain/mail/messages.ts');
  const {findMatchCandidates,recordMatches}=await import('@fss/domain/mail/matching.ts');
  const {applyClassificationEffects,recordDeterministicClassification}=await import('@fss/domain/mail/effects.ts');
  const {recordingSuppressionJournal}=await import('@fss/domain/suppression/journal.ts');
  const {recordingReplyPromoter}=await import('@fss/domain/mail/replyLane.ts');
  const metadata={providerMessageId:randomUUID(),providerThreadId:randomUUID(),rfcMessageId:`${randomUUID()}@example.test`,direction:'incoming' as const,internalDate:new Date().toISOString(),headerFrom:'info@senderofficepm.example.test',headerTo:['owner@example.test'],headerCc:[],subject:'Re: Maintenance',referenceMessageIds:[],inReplyTo:null,autoSubmitted:null,listId:null,labelIds:[],attachments:[]};
  const m=await tx(()=>recordMessage(worker(),{mailboxId,metadata}));
  const candidates=await findMatchCandidates(worker(),{mailboxId,messageId:m.message.id,metadata});
  const classification={messageId:m.message.id,class:change==='reply'?'human' as const:'opt_out' as const,suggestedDisposition:null,signals:[],requiresConfirmation:false};
  await tx(async()=>{await recordMatches(worker(),{messageId:m.message.id,candidates});await recordDeterministicClassification(worker(),{messageId:m.message.id,classification});await applyClassificationEffects(worker(),{message:m.message,classification,candidates,journal:recordingSuppressionJournal(),replyPromoter:recordingReplyPromoter()});});
 }
 const {dispatchOutboundMessage}=await import('@fss/domain/outbound/send.ts');
 expect(await dispatchOutboundMessage(f.timed,f.deps,{outboundMessageId:f.fenceId})).toMatchObject({outcome:'held'});
 expect(f.gmail.sends).toHaveLength(0);
 if(change!=='opt_out')expect(await readEnrollment(worker(),{enrollmentId:f.enrollmentId})).toMatchObject({endReason:change==='reply'?'human_reply':'engaged_call'});
});
it('exhausts seven hourly capacity checks without buying research or accumulating new enrollments',async()=>{
 await configureFutureActivation();const prospect=await qualified('Bounded Capacity');
 await db.session.query('UPDATE mailbox_send_ramp SET admin_daily_cap=0,admin_changed_at=now(),admin_changed_by_user_id=$2 WHERE mailbox_id=$1',[mailboxId,seeded.alpha.admin.userId]);
 for(let i=0;i<7;i++){
  const report=await runAutomaticEmailBatch(worker(),2);
  expect(report).toMatchObject({checked:1,admitted:[],deferred:[{reason:i===6?'rechecks_exhausted':'mailbox_capacity_exhausted'}]});
  await db.session.query("UPDATE sourcing_qualification_runs SET email_admission_next_at=CASE WHEN email_admission_next_at IS NOT NULL THEN now()-interval '1 minute' ELSE NULL END WHERE id=$1",[prospect.qualificationRunId]);
 }
 expect(await runAutomaticEmailBatch(worker(),2)).toMatchObject({checked:0,admitted:[]});
 expect(await listEnrollments(worker())).toHaveLength(0);
});
it('prefers a supported named contact after equal rank, corroboration, and recency',async()=>{
 await configureFutureActivation();const retrievedAt=new Date().toISOString();
 await qualified('A Office Tie',{retrievedAt});
 const named=await qualified('Z Named Tie',{retrievedAt,named:true});
 await db.session.query('UPDATE mailbox_send_ramp SET admin_daily_cap=1,admin_changed_at=now(),admin_changed_by_user_id=$2 WHERE mailbox_id=$1',[mailboxId,seeded.alpha.admin.userId]);
 const batch=await runAutomaticEmailBatch(worker(),2);
 expect(batch.admitted).toMatchObject([{candidateId:named.candidateId}]);
 const [enrollment]=await listEnrollments(worker());if(!enrollment)throw new Error('missing enrollment');
 expect(await listContacts(worker(),enrollment.firmId)).toMatchObject([{full_name:'Jane Smith'}]);
});
it('selects only the newest qualification for the current candidate revision',async()=>{
 await configureFutureActivation();const old=await qualified('Changed Batch Evidence');
 await db.session.query(`INSERT INTO sourcing_qualification_runs(workspace_id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name,requested_at)
 SELECT workspace_id,candidate_id,candidate_revision,$2,prompt_version,policy_version,model_name,requested_at+interval '1 second' FROM sourcing_qualification_runs WHERE id=$1`,[old.qualificationRunId,'e'.repeat(64)]);
 expect(await runAutomaticEmailBatch(worker(),2)).toMatchObject({checked:0,admitted:[]});
});
it('waits for the next business-day allowance instead of exhausting capacity checks overnight',async()=>{
 await configureFutureActivation();await qualified('Reset Capacity Fit');
 await db.session.query('UPDATE mailbox_send_ramp SET admin_daily_cap=0,admin_changed_at=now(),admin_changed_by_user_id=$2 WHERE mailbox_id=$1',[mailboxId,seeded.alpha.admin.userId]);
 const day=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/New_York'});
 const tomorrow=new Date(`${day.format(new Date())}T12:00:00Z`);tomorrow.setUTCDate(tomorrow.getUTCDate()+1);
 const report=await runAutomaticEmailBatch(worker(),2),wake=report.deferred[0]?.retryAt;
 expect(report).toMatchObject({deferred:[{reason:'mailbox_capacity_exhausted'}]});
 if(!wake)throw new Error('missing capacity wake');
 expect(day.format(new Date(wake))).toBe(tomorrow.toISOString().slice(0,10));
 expect(new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(wake))).toBe('00:05');
});

import {readSourcingLearning} from '@fss/domain/sourcing/learningReport.ts';
const learningInterval=()=>({from:new Date(Date.now()-86400000).toISOString(),to:new Date(Date.now()+1000).toISOString(),asOf:new Date(Date.now()+1000).toISOString()});
it('shows an automatic unsent enrollment in learning without manufacturing contact or delivery',async()=>{
 await configureFutureActivation();const input=await qualified('Learning Unsent PM');
 const result=await admitAutomaticEmailProspect(worker(),input);if(!result.ok)throw new Error(result.reason);
 const view=await tx(()=>readSourcingLearning(admin(),learningInterval()));
 expect(view).toMatchObject({cohorts:[],coverage:{admitted:1},automation:{outcomes:{admissions:1,attempts:0,sent:0,replies:0,booked:0,heldQualified:0},decisions:[{candidateId:input.candidateId,runId:input.qualificationRunId,reason:'enrolled',firmId:result.value.firmId,enrollmentId:result.value.enrollmentId}]}});
 expect(await tx(()=>saveEmailAdmissionControl(admin(),{enabled:false,ownerUserId:seeded.alpha.admin.userId,mailboxId,sequenceVersionId:sequenceId,evaluation:null,expectedRevision:2}))).toMatchObject({ok:true});
 const {learningReportSchema}=await import('@fss/contracts');
 const changed=learningReportSchema.parse(await tx(()=>readSourcingLearning(admin(),learningInterval())));
 expect(changed.automation).toMatchObject({control:{enabled:false,revision:3},decisions:[{controlRevision:2,evaluationSha256:'b'.repeat(64),implementationCommit:'a'.repeat(40),sequenceVersionId:sequenceId}]});
});
it('counts one actual send and automatic email attribution after sender replay',async()=>{
 const f=await preparedAutomaticSender();const {dispatchOutboundMessage}=await import('@fss/domain/outbound/send.ts');
 await dispatchOutboundMessage(f.timed,f.deps,{outboundMessageId:f.fenceId});await dispatchOutboundMessage(f.timed,f.deps,{outboundMessageId:f.fenceId});
 const {reconcileEmailAttribution}=await import('@fss/domain/sourcing/attribution.ts');
 await tx(()=>reconcileEmailAttribution(worker()));await tx(()=>reconcileEmailAttribution(worker()));
 const asOf=new Date(Date.parse(f.at)+1000).toISOString();
 const view=await tx(()=>readSourcingLearning(admin(),{...learningInterval(),to:asOf,asOf}));
 expect(view).toMatchObject({automation:{outcomes:{admissions:1,attempts:1,sent:1}},cohorts:[{policyVersion:'outreach-email-fit-v1',contacted:1,email:{sent:1}}]});
});
it('shows permanent deferral and exhausted capacity checks with historical evidence and bindings',async()=>{
 await configureFutureActivation();const fit=await qualified('Visible Capacity PM');
 const contrary=await qualified('Visible Contrary PM',{need:'We do not need maintenance help.'});
 await db.session.query('UPDATE mailbox_send_ramp SET admin_daily_cap=0,admin_changed_at=now(),admin_changed_by_user_id=$2 WHERE mailbox_id=$1',[mailboxId,seeded.alpha.admin.userId]);
 for(let i=0;i<7;i++){await runAutomaticEmailBatch(worker(),2);await db.session.query("UPDATE sourcing_qualification_runs SET email_admission_next_at=now()-interval '1 minute' WHERE id=$1 AND email_admission_next_at IS NOT NULL",[fit.qualificationRunId]);}
 const view=await tx(()=>readSourcingLearning(admin(),learningInterval()));
 expect(view.automation?.decisions).toHaveLength(2);
 expect(view.automation?.decisions).toEqual(expect.arrayContaining([
 expect.objectContaining({candidateId:fit.candidateId,reason:'mailbox_capacity_exhausted',status:'exhausted',checks:7,retryAt:null,rank:'fit_only',policyVersion:'outreach-email-fit-v1',promptVersion:'qualification-growth-v6',controlRevision:2,sequenceVersionId:sequenceId,evaluationSha256:'b'.repeat(64),implementationCommit:'a'.repeat(40),firmId:null,enrollmentId:null}),
 expect.objectContaining({candidateId:contrary.candidateId,status:'deferred',checks:1,retryAt:null,evidence:expect.arrayContaining([expect.objectContaining({url:'https://visiblecontrarypm.example.test/'})])})]));
});
it('distinguishes retained discovery hits and supported email prospects from manual staging without double counting',async()=>{
 await configureFutureActivation();const found=await qualified('Discovered Office PM');await qualified('Manual Staged PM');
 const attempt=(await db.session.query<{id:string}>("INSERT INTO sourcing_discovery_attempts(workspace_id,query_id,query,state) VALUES($1,'dfw','Dallas residential property management','complete') RETURNING id",[seeded.alpha.workspaceId])).rows[0]!.id;
 for(const suffix of ['a','b'])await db.session.query('INSERT INTO sourcing_discovery_hits(workspace_id,source_url,attempt_id,candidate_id) VALUES($1,$2,$3,$4)',[seeded.alpha.workspaceId,`https://discoveredofficepm.example.test/${suffix}`,attempt,found.candidateId]);
 const result=await admitAutomaticEmailProspect(worker(),found);if(!result.ok)throw new Error(result.reason);
 expect(await tx(()=>readSourcingLearning(admin(),learningInterval()))).toMatchObject({automation:{discovery:{retainedHits:2,supportedProspects:1,admissions:1,manualStaged:1,unavailable:0}}});
});
it('keeps substantive replies, delivery failures, opt-outs and bookings separate from attended qualified conversations',async()=>{
 const f=await preparedAutomaticSender();
 const {recordMessage}=await import('@fss/domain/mail/messages.ts');const {findMatchCandidates,recordMatches}=await import('@fss/domain/mail/matching.ts');const {recordDeterministicClassification}=await import('@fss/domain/mail/effects.ts');
 for(const kind of ['human','bounce','opt_out'] as const){
  const metadata={providerMessageId:randomUUID(),providerThreadId:randomUUID(),rfcMessageId:`${randomUUID()}@example.test`,direction:'incoming' as const,internalDate:new Date().toISOString(),headerFrom:'info@senderofficepm.example.test',headerTo:['owner@example.test'],headerCc:[],subject:'Re: Maintenance',referenceMessageIds:[],inReplyTo:null,autoSubmitted:null,listId:null,labelIds:[],attachments:[]};
  const m=await tx(()=>recordMessage(worker(),{mailboxId,metadata}));const candidates=await findMatchCandidates(worker(),{mailboxId,messageId:m.message.id,metadata});
  await tx(async()=>{await recordMatches(worker(),{messageId:m.message.id,candidates});await recordMatches(worker(),{messageId:m.message.id,candidates});await recordDeterministicClassification(worker(),{messageId:m.message.id,classification:{messageId:m.message.id,class:kind,suggestedDisposition:null,signals:[],requiresConfirmation:false}});});
 }
 const {receiveCalcomEvent}=await import('@fss/domain/meetings/calcom.ts');
 const body={triggerEvent:'BOOKING_CREATED',createdAt:new Date().toISOString(),payload:{uid:randomUUID(),startTime:f.at,endTime:new Date(Date.parse(f.at)+1800000).toISOString(),organizer:{email:'owner@example.test'},attendees:[{email:'info@senderofficepm.example.test',name:'Office'}]}};
 await tx(()=>receiveCalcomEvent(db.session,{workspaceId:seeded.alpha.workspaceId,rawBody:Buffer.from(JSON.stringify(body)),body}));await tx(()=>receiveCalcomEvent(db.session,{workspaceId:seeded.alpha.workspaceId,rawBody:Buffer.from(JSON.stringify(body)),body}));
 const view=await tx(()=>readSourcingLearning(admin(),learningInterval()));
 expect(view.automation).toMatchObject({outcomes:{admissions:1,attempts:0,sent:0,replies:1,deliveryFailures:1,optOuts:1,booked:1,heldQualified:0,unknownQualification:1},attention:[{firmId:f.firmId,needsReply:1,bookings:1,heldQualified:0}]});
});
it('restricts automatic decisions, evidence and outcome totals to the workspace and assigned owner',async()=>{
 await configureFutureActivation();const input=await qualified('Private Owner PM');const result=await admitAutomaticEmailProspect(worker(),input);if(!result.ok)throw new Error(result.reason);
 const sales=repositoryContext(workspaceScope(seeded.alpha.workspaceId,{kind:'user',userId:seeded.alpha.salesperson.userId,role:'salesperson'}),db.session);
 const beta=repositoryContext(workspaceScope(seeded.beta.workspaceId,{kind:'user',userId:seeded.beta.admin.userId,role:'admin'}),db.session);
 for(const scoped of [sales,beta])expect((await tx(()=>readSourcingLearning(scoped,learningInterval()))).automation).toMatchObject({decisions:[],attention:[],outcomes:{admissions:0,sent:0},discovery:{manualStaged:0}});
 await db.session.query('UPDATE firms SET assigned_user_id=$2 WHERE id=$1',[result.value.firmId,seeded.alpha.salesperson.userId]);
 expect((await tx(()=>readSourcingLearning(sales,learningInterval()))).automation).toMatchObject({decisions:[{firmId:result.value.firmId}],outcomes:{admissions:1}});
});
it('makes a whole-batch binding refusal visible without fabricating a prospect decision',async()=>{
 await configureFutureActivation();await qualified('Batch Binding PM');vi.stubEnv('FSS_BUILD_COMMIT','f'.repeat(40));
 expect(await runAutomaticEmailBatch(worker(),2)).toMatchObject({reason:'evaluation_mismatch',checked:0});
 expect((await tx(()=>readSourcingLearning(admin(),learningInterval()))).automation).toMatchObject({control:{enabled:true,revision:2,lastBatchReason:'evaluation_mismatch'},decisions:[],outcomes:{admissions:0}});
});
it('joins confirmed feedback and qualification spend through automatic email attribution',async()=>{
 const f=await preparedAutomaticSender();
 const {dispatchOutboundMessage}=await import('@fss/domain/outbound/send.ts');await dispatchOutboundMessage(f.timed,f.deps,{outboundMessageId:f.fenceId});
 const {reconcileEmailAttribution}=await import('@fss/domain/sourcing/attribution.ts');await tx(()=>reconcileEmailAttribution(worker()));
 const {recordSourcingFeedback}=await import('@fss/domain/sourcing/feedback.ts');
 expect(await tx(()=>recordSourcingFeedback(admin(),{candidateId:f.candidateId,qualificationRunId:f.qualificationRunId,code:'real_pain'}))).toMatchObject({ok:true});
 const {reserveAttempt,markCalling,settleAttempt}=await import('@fss/domain/research/reservations.ts');const at=new Date().toISOString();
 const paid=await tx(()=>reserveAttempt(worker(),{subjectKind:'sourcing_qualification',subjectId:f.qualificationRunId,attempt:1,providerKey:'aws_bedrock.sourcing_qualification',at,businessTimeZone:'America/New_York',cents:2,modelName:'fixture',maxInputTokens:1000,maxOutputTokens:100}));
 await tx(()=>markCalling(worker(),paid.id));await tx(()=>settleAttempt(worker(),{reservationId:paid.id,at,outcome:{kind:'estimated'}}));
 const asOf=new Date(Date.parse(f.at)+1000).toISOString();const view=await tx(()=>readSourcingLearning(admin(),{...learningInterval(),to:asOf,asOf}));
 expect(view.cohorts).toMatchObject([{policyVersion:'outreach-email-fit-v1',confirmedPain:1,researchGrossCents:2,researchCashCents:0}]);
});
