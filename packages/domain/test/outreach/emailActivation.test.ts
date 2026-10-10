import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {readEmailAdmissionReadiness,activateEmailAdmission,prepareEmailAdmissionActivation} from '../../outreach/emailActivation.ts';
let db:TestDatabase,seed:TwoWorkspaces;
const admin=()=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),db.session);
beforeEach(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);});
afterEach(async()=>{vi.unstubAllEnvs();await db.drop();});
it('does not claim activation readiness without trusted running image identity or current configuration',async()=>{
 expect(await readEmailAdmissionReadiness(admin())).toMatchObject({enabled:false,ready:false,receiptId:null,readinessSha256:null,reasons:['runtime_identity_unknown','configuration_required']});
});

it('refuses a stale explicit activation without creating configuration or admitting recipients',async()=>{
 expect(await activateEmailAdmission(admin(),{expectedControlRevision:7,expectedReadinessSha256:'a'.repeat(64),receiptId:'11111111-1111-4111-8111-111111111111'})).toEqual({ok:false,reason:'stale_revision'});
 expect(await readEmailAdmissionReadiness(admin())).toMatchObject({enabled:false,controlRevision:0,ready:false});
});

import {seedSequences} from '../sequences/support/sequenceFixtures.ts';
import {setProspectingAuthorization} from '../../outreach/authorization.ts';
import {saveEmailAdmissionControl,readEmailAdmissionControl} from '../../outreach/emailControl.ts';
import {withTransaction} from '../../db/queryable.ts';
import {controlledActivationProof} from './support/emailActivationFixture.ts';
async function configured(){
 const commit='a'.repeat(40);vi.stubEnv('FSS_BUILD_COMMIT',commit);
 const sequences=await seedSequences(db.session,seed);
 const mailboxId=(await db.session.query<{id:string}>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status,sync_state,coverage_watermark_at,history_id,history_id_updated_at,baseline_completed_at,baseline_from_at) VALUES($1,$2,'owner@example.test','fixture','connected','ready',clock_timestamp(),'123',clock_timestamp(),clock_timestamp(),clock_timestamp()-interval '1 day') RETURNING id",[seed.alpha.workspaceId,seed.alpha.admin.userId])).rows[0]!.id;
 await db.session.query('INSERT INTO mailbox_send_ramp(workspace_id,mailbox_id) VALUES($1,$2)',[seed.alpha.workspaceId,mailboxId]);
 await db.session.query("INSERT INTO sending_domains(workspace_id,domain,is_primary,spf_pass,dkim_pass,dmarc_pass,automated_sending_enabled,automated_sending_enabled_at,authentication_checked_at,authentication_checked_by_user_id,postmaster_reviewed_at) VALUES($1,'example.test',true,true,true,true,true,now(),now(),$2,now())",[seed.alpha.workspaceId,seed.alpha.admin.userId]);
 await withTransaction(db.session,()=>setProspectingAuthorization(admin(),{mailboxId,expectedRevision:0,enabled:true,basis:'owner_reported_google_permission'}));
 const seq=(await db.session.query<{id:string}>('INSERT INTO sequences(workspace_id,name,created_by_user_id) VALUES($1,$2,$3) RETURNING id',[seed.alpha.workspaceId,'Activation fixture',seed.alpha.admin.userId])).rows[0]!.id;
 const sequenceId=(await db.session.query<{id:string}>('INSERT INTO sequence_versions(workspace_id,sequence_id,version) VALUES($1,$2,1) RETURNING id',[seed.alpha.workspaceId,seq])).rows[0]!.id;
 for(let i=0;i<5;i++)await db.session.query("INSERT INTO sequence_steps(workspace_id,sequence_version_id,ordinal,channel,delay_unit,delay_amount,template_version_id) VALUES($1,$2,$3,'email','elapsed',0,$4)",[seed.alpha.workspaceId,sequenceId,i+1,sequences.alpha.template.templateVersionId]);
 await db.session.query("UPDATE sequence_versions SET state='published',published_at=now(),published_by_user_id=$2 WHERE id=$1",[sequenceId,seed.alpha.admin.userId]);
 const config={enabled:false,ownerUserId:seed.alpha.admin.userId,mailboxId,sequenceVersionId:sequenceId,evaluation:null};
 expect(await withTransaction(db.session,()=>saveEmailAdmissionControl(admin(),{...config,expectedRevision:0}))).toMatchObject({ok:true});
 const f=await controlledActivationProof(admin(),mailboxId,sequenceId,commit);
 const c=await readEmailAdmissionControl(admin());
 const evaluation={policyVersion:'outreach-email-fit-v2',promptVersion:'qualification-growth-v6',implementationCommit:commit,configurationSha256:c.configurationSha256,reportSha256:f.reportSha256,reviewedEligible:1,falseEligible:0};
 expect(await withTransaction(db.session,()=>saveEmailAdmissionControl(admin(),{...config,evaluation,expectedRevision:1}))).toMatchObject({ok:true});
 return {...f,mailboxId,sequenceId};
}
it('retains documentary proof without enabling; explicit exact readiness enables only the existing bound configuration',async()=>{
 const f=await configured();
 const prepared=await withTransaction(db.session,()=>prepareEmailAdmissionActivation(admin(),{expectedControlRevision:2,proof:f.proof},f.runtime));
 expect(prepared).toMatchObject({ok:true});if(!prepared.ok)throw new Error(prepared.reason);
 expect(await readEmailAdmissionReadiness(admin(),f.runtime)).toMatchObject({enabled:false,ready:true,receiptId:prepared.value.receiptId,reasons:[]});
 expect(await withTransaction(db.session,()=>activateEmailAdmission(admin(),{expectedControlRevision:2,receiptId:prepared.value.receiptId,expectedReadinessSha256:prepared.value.readinessSha256},f.runtime))).toEqual({ok:true,value:{revision:3}});
 expect(await readEmailAdmissionReadiness(admin(),f.runtime)).toMatchObject({enabled:true,ready:true,controlRevision:3});
});
it('refuses a changed readiness digest and authorization revoked after evidence preparation',async()=>{
 const f=await configured();const prepared=await withTransaction(db.session,()=>prepareEmailAdmissionActivation(admin(),{expectedControlRevision:2,proof:f.proof},f.runtime));if(!prepared.ok)throw new Error(prepared.reason);
 expect(await withTransaction(db.session,()=>activateEmailAdmission(admin(),{expectedControlRevision:2,receiptId:prepared.value.receiptId,expectedReadinessSha256:'f'.repeat(64)},f.runtime))).toEqual({ok:false,reason:'activation_readiness_changed'});
 await withTransaction(db.session,()=>setProspectingAuthorization(admin(),{mailboxId:f.mailboxId,expectedRevision:1,enabled:false,basis:'owner_reported_google_permission'}));
 expect(await withTransaction(db.session,()=>activateEmailAdmission(admin(),{expectedControlRevision:2,receiptId:prepared.value.receiptId,expectedReadinessSha256:prepared.value.readinessSha256},f.runtime))).toEqual({ok:false,reason:'mailbox_not_authorized'});
 expect(await readEmailAdmissionReadiness(admin(),f.runtime)).toMatchObject({enabled:false,ready:false});
});
it('does not accept provider send IDs or domain checklist flags instead of received aligned authentication',async()=>{
 const f=await configured();f.proof.received.headerText='From: owner@example.test\r\nReturn-Path: <owner@example.test>\r\nAuthentication-Results: mx.google.com; spf=pass smtp.mailfrom=owner@example.test; dkim=fail header.i=@example.test; dmarc=pass header.from=example.test';
 expect(await withTransaction(db.session,()=>prepareEmailAdmissionActivation(admin(),{expectedControlRevision:2,proof:f.proof},f.runtime))).toEqual({ok:false,reason:'received_authentication_unverified'});
 expect(await readEmailAdmissionReadiness(admin(),f.runtime)).toMatchObject({enabled:false,receiptId:null,ready:false});
});
it('reports the actual enabled control and workers fail closed without their own runtime identity',async()=>{
 const f=await configured();const prepared=await withTransaction(db.session,()=>prepareEmailAdmissionActivation(admin(),{expectedControlRevision:2,proof:f.proof},f.runtime));if(!prepared.ok)throw new Error(prepared.reason);
 await withTransaction(db.session,()=>activateEmailAdmission(admin(),{expectedControlRevision:2,receiptId:prepared.value.receiptId,expectedReadinessSha256:prepared.value.readinessSha256},f.runtime));
 expect(await readEmailAdmissionControl(admin(),f.runtime)).toMatchObject({enabled:true,ready:true,revision:3});
 const {automaticEmailConfiguration}=await import('../../outreach/emailControl.ts');
 const worker=repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'system',component:'worker'}),db.session);
 expect(await withTransaction(db.session,()=>automaticEmailConfiguration(worker,3))).toEqual({ok:false,reason:'runtime_identity_unknown'});
 expect(await withTransaction(db.session,()=>automaticEmailConfiguration(worker,3,{...f.runtime,side:'worker',imageDigest:f.proof.release.workerDigest}))).toMatchObject({ok:true});
 expect(await withTransaction(db.session,()=>saveEmailAdmissionControl(admin(),{expectedRevision:3,enabled:false,ownerUserId:seed.alpha.admin.userId,mailboxId:f.mailboxId,sequenceVersionId:f.sequenceId,evaluation:null}))).toMatchObject({ok:true});
 expect(await withTransaction(db.session,()=>automaticEmailConfiguration(worker,4,f.runtime))).toEqual({ok:false,reason:'automatic_email_disabled'});
});
it('rejects a retained report that claims reviewed positives while every case is synthetic',async()=>{
 const f=await configured();const report=JSON.parse(f.proof.evaluationReportJson);report.cases[0].provenance.kind='synthetic_boundary';f.proof.evaluationReportJson=JSON.stringify(report);
 const {createHash}=await import('node:crypto');const c=await readEmailAdmissionControl(admin());
 await withTransaction(db.session,()=>saveEmailAdmissionControl(admin(),{expectedRevision:2,enabled:false,ownerUserId:seed.alpha.admin.userId,mailboxId:f.mailboxId,sequenceVersionId:f.sequenceId,evaluation:{...c.evaluation!,reportSha256:createHash('sha256').update(f.proof.evaluationReportJson).digest('hex')}}));
 expect(await withTransaction(db.session,()=>prepareEmailAdmissionActivation(admin(),{expectedControlRevision:3,proof:f.proof},f.runtime))).toEqual({ok:false,reason:'evaluation_incomplete'});
});
it('refuses a failed deployment status despite embedded smoke and service success fields',async()=>{
 const f=await configured();const deployment=JSON.parse(f.proof.release.deploymentReceiptJson);deployment.status='failed';f.proof.release.deploymentReceiptJson=JSON.stringify(deployment);
 expect(await withTransaction(db.session,()=>prepareEmailAdmissionActivation(admin(),{expectedControlRevision:2,proof:f.proof},f.runtime))).toEqual({ok:false,reason:'release_evidence_mismatch'});
});
it('observes a concurrent authorization revocation before exact activation can acquire the send gate',async()=>{
 const f=await configured();const prepared=await withTransaction(db.session,()=>prepareEmailAdmissionActivation(admin(),{expectedControlRevision:2,proof:f.proof},f.runtime));if(!prepared.ok)throw new Error(prepared.reason);
 const session=await db.appRuntimeSession(),other=repositoryContext(admin().scope,session);
 const pid=(await session.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
 await db.session.query('BEGIN');
 try{
  expect(await setProspectingAuthorization(admin(),{mailboxId:f.mailboxId,expectedRevision:1,enabled:false,basis:'owner_reported_google_permission'})).toMatchObject({ok:true});
  const attempt=withTransaction(session,()=>activateEmailAdmission(other,{expectedControlRevision:2,receiptId:prepared.value.receiptId,expectedReadinessSha256:prepared.value.readinessSha256},f.runtime));
  await expect.poll(async()=>(await db.session.query<{wait_event_type:string}>('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.wait_event_type,{timeout:2000}).toBe('Lock');
  await db.session.query('COMMIT');expect(await attempt).toEqual({ok:false,reason:'mailbox_not_authorized'});
 }finally{await db.session.query('ROLLBACK');}
 expect(await readEmailAdmissionReadiness(admin(),f.runtime)).toMatchObject({enabled:false,ready:false});
});
it('keeps prepared receipts immutable for the application role',async()=>{
 const f=await configured();const prepared=await withTransaction(db.session,()=>prepareEmailAdmissionActivation(admin(),{expectedControlRevision:2,proof:f.proof},f.runtime));if(!prepared.ok)throw new Error(prepared.reason);
 const runtime=await db.appRuntimeSession();
 await expect(runtime.query('UPDATE outreach_email_admission_activation_receipts SET proof_sha256=$1 WHERE workspace_id=$2 AND id=$3',['f'.repeat(64),seed.alpha.workspaceId,prepared.value.receiptId])).rejects.toThrow('permission denied');
 await expect(runtime.query('DELETE FROM outreach_email_admission_activation_receipts WHERE workspace_id=$1 AND id=$2',[seed.alpha.workspaceId,prepared.value.receiptId])).rejects.toThrow('permission denied');
 expect(await readEmailAdmissionReadiness(admin(),f.runtime)).toMatchObject({enabled:false,ready:true,receiptId:prepared.value.receiptId});
});
it.each(['paused','absent'])('respects the current deployment sending pause through readiness, prepare, activate and worker (%s)',async flag=>{
 const f=await configured();const prepared=await withTransaction(db.session,()=>prepareEmailAdmissionActivation(admin(),{expectedControlRevision:2,proof:f.proof},f.runtime));if(!prepared.ok)throw new Error(prepared.reason);
 const stopped={...f.runtime,deploymentSendingEnabled:false};if(flag==='absent')Reflect.deleteProperty(stopped,'deploymentSendingEnabled');
 expect(await readEmailAdmissionReadiness(admin(),stopped)).toMatchObject({enabled:false,ready:false,reasons:expect.arrayContaining(['deployment_sending_disabled'])});
 expect(await withTransaction(db.session,()=>prepareEmailAdmissionActivation(admin(),{expectedControlRevision:2,proof:f.proof},stopped))).toEqual({ok:false,reason:'deployment_sending_disabled'});
 expect(await withTransaction(db.session,()=>activateEmailAdmission(admin(),{expectedControlRevision:2,receiptId:prepared.value.receiptId,expectedReadinessSha256:prepared.value.readinessSha256},stopped))).toEqual({ok:false,reason:'deployment_sending_disabled'});
 expect(await withTransaction(db.session,()=>activateEmailAdmission(admin(),{expectedControlRevision:2,receiptId:prepared.value.receiptId,expectedReadinessSha256:prepared.value.readinessSha256},f.runtime))).toMatchObject({ok:true});
 const {automaticEmailConfiguration}=await import('../../outreach/emailControl.ts');const worker=repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'system',component:'worker'}),db.session);
 expect(await withTransaction(db.session,()=>automaticEmailConfiguration(worker,3,{...stopped,side:'worker',imageDigest:f.proof.release.workerDigest}))).toEqual({ok:false,reason:'deployment_sending_disabled'});
});
