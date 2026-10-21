import { expect, it } from 'vitest';
import { captureRecoveryFixture } from './support/captureReadRecoveryFixture.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { repositoryContext } from '@fss/domain/db/workspaceScope.ts';
import { captureReadAuthority } from '@fss/domain/mail/crmCaptureReadAuthority.ts';
import { requestCaptureReadRecovery } from '@fss/domain/mail/crmCaptureReadRecovery.ts';
import { claimJobs } from '@fss/domain/jobs/jobStore.ts';
import { runCaptureReadProbe } from '@fss/domain/mail/crmCaptureReadProbe.ts';
import { TABLE_RETENTION_COVERAGE } from '@fss/domain/retention/coverage.ts';

it('real concurrent commands and job claims conserve the unique one-use incident attempt',async()=>{
 const f=await captureRecoveryFixture();try{
  const a=await withTransaction(f.session,()=>captureReadAuthority(f.context,f.m.id,f.runtime));if(!a.ok)throw new Error('authority');
  const session=await f.fixture.database.appRuntimeSession(),other=repositoryContext(f.context.scope,session);
  const payload={mailboxId:f.m.id,expectedGeneration:1,incidentId:f.incident,expectedRecoveryBinding:a.authority.binding};
  const results=await Promise.all([withTransaction(f.session,()=>requestCaptureReadRecovery(f.context,payload,f.runtime)),withTransaction(session,()=>requestCaptureReadRecovery(other,payload,f.runtime))]);
  expect(results[0]).toEqual(results[1]);expect((await f.db.query('SELECT id FROM crm_capture_read_recoveries')).rows).toHaveLength(1);
  const claims=await Promise.all([claimJobs(f.session,{owner:'racer-one',kinds:['crm.capture_read_recovery'],limit:1,leaseSeconds:120}),claimJobs(session,{owner:'racer-two',kinds:['crm.capture_read_recovery'],limit:1,leaseSeconds:120})]);
  expect(claims.flat()).toHaveLength(1);
  const job=claims.flat()[0]!,winningSession=claims[0].length?f.session:session;
  await runCaptureReadProbe({scope:f.system.scope,session:winningSession,job},{gmail:f.fake,oauth:f.oauth,cipher:f.cipher,runtime:f.runtime});
  expect(f.fake.calls.map(c=>c.method)).toEqual(['refreshAccessToken','getProfile']);
 }finally{await f.stop();}
});

it('locked schema grants protect cutoff/identity and terminal audit immutability, with cascade cleanup',async()=>{
 const f=await captureRecoveryFixture();try{
  const result=await f.request();if(!result.ok)throw new Error('request');await f.run('crm.capture_read_recovery');
  await expect(f.session.query("UPDATE crm_capture_read_recoveries SET state='probing',completed_at=NULL,coded_outcome=NULL WHERE id=$1",[result.value.attemptId])).rejects.toThrow('Invalid capture read recovery transition');
  await expect(f.session.query('UPDATE crm_capture_read_progress SET forward_cutoff_at=forward_cutoff_at-interval \'1 day\'')).rejects.toMatchObject({code:'42501'});
  await expect(f.session.query('UPDATE crm_capture_read_progress SET generation=2')).rejects.toMatchObject({code:'42501'});
  await expect(f.session.query('UPDATE crm_capture_read_recoveries SET incident_id=$1',[f.incident])).rejects.toMatchObject({code:'42501'});
  await expect(f.session.query('DELETE FROM crm_capture_read_recoveries')).rejects.toMatchObject({code:'42501'});
  expect(TABLE_RETENTION_COVERAGE['crm_capture_read_recoveries']?.dispositions).toContain('retained');
  expect(TABLE_RETENTION_COVERAGE['crm_capture_read_progress']?.dispositions).toContain('operational');
  // Test-only superuser removal of the original incident exercises the declared FK lifecycle.
  await f.db.query('DELETE FROM mailbox_provider_incidents WHERE id=$1',[f.incident]);
  expect((await f.db.query('SELECT * FROM crm_capture_read_recoveries')).rows).toHaveLength(0);
  expect((await f.db.query('SELECT * FROM crm_capture_read_progress')).rows).toHaveLength(0);
 }finally{await f.stop();}
});

it('cross-workspace audit and foreign recovery progress bindings fail at actual composite FKs',async()=>{
 const f=await captureRecoveryFixture();try{
  const result=await f.request();if(!result.ok)throw new Error('request');await f.run('crm.capture_read_recovery');
  await expect(f.db.query(`INSERT INTO crm_capture_read_progress(workspace_id,recovery_id,mailbox_id,generation,forward_cutoff_at,window_from_at)
   SELECT $1,id,mailbox_id,generation,clock_timestamp(),clock_timestamp() FROM crm_capture_read_recoveries WHERE id=$2`,[f.fixture.beta.workspaceId,result.value.attemptId])).rejects.toMatchObject({code:'23503'});
  await expect(f.db.query(`INSERT INTO crm_capture_read_recoveries(workspace_id,mailbox_id,generation,incident_id,requester_user_id,owner_user_id,owner_approval_id,controls_revision,policy_revision,recovery_binding_sha256)
   SELECT $1,mailbox_id,generation,incident_id,$2,$2,owner_approval_id,controls_revision,policy_revision,recovery_binding_sha256 FROM crm_capture_read_recoveries WHERE id=$3`,[f.fixture.beta.workspaceId,f.fixture.beta.admin.userId,result.value.attemptId])).rejects.toMatchObject({code:'23503'});
 }finally{await f.stop();}
});
