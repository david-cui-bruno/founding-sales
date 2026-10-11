import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {crmAcquisitionDiagnosticAuthorizationSchema,type CrmAcquisitionDiagnosticAuthorization} from '@fss/contracts';
import {REQUIRED_SCHEMA} from '@fss/domain/db/schemaRange.ts';
import {withTransaction,type SessionQueryable} from '@fss/domain/db/queryable.ts';
import {repositoryContext,workspaceScope,type RepositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {readBusinessPolicy} from '@fss/domain/business/acquisition.ts';
import {CRM_MAIL_CAPTURE_DISCLOSURE} from '@fss/domain/crm/capabilityAuthority.ts';
import {putReleaseRecord} from '@fss/domain/release/records.ts';
import {fixtureCiGateRecord,FIXTURE_CI_COMMIT,FIXTURE_API_DIGEST,FIXTURE_WORKER_DIGEST} from '@fss/domain/test/release/support/releaseRecords.ts';
import {provisionCrmAcquisitionDiagnostic,prepareCrmAcquisitionDiagnosticIsolation,requestCrmAcquisitionDiagnostic,readCrmAcquisitionDiagnostic,crmAcquisitionDiagnosticFingerprint,type CrmAcquisitionDiagnosticRuntime} from '@fss/domain/mail/crmAcquisitionDiagnostic.ts';
import {createCrmAcquisitionDiagnosticCapture} from '@fss/domain/mail/crmAcquisitionDiagnosticCapture.ts';
import {recordedGmailClient} from '@fss/domain/mail/gmailClientFake.ts';
import {businessMailCaptureHandler} from '@fss/domain/mail/crmSources.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {runOnce} from '../../apps/worker/src/runner/jobRunner.ts';
import type {FixtureHandles} from './fixture.ts';

export const DIAGNOSTIC_UPGRADE_WORKFLOW='crm.acquisition diagnostic (registered controlled worker)';
const reviewReference='upgrade-controlled-current-diagnostic';

/** Fixture preparation runs in the checked HEAD child as migration, never app_runtime.
 * It creates synthetic authority in the disposable upgraded database only. Existing
 * production controls and the surviving fixture mailbox are not modified. */
export async function prepareDiagnosticUpgradeFixture(session:SessionQueryable,handles:FixtureHandles):Promise<void>{
 const database=(await session.query<{name:string}>('SELECT current_database() AS name')).rows[0]!.name;
 assert(database.startsWith('fss_upgrade_'),'Diagnostic upgrade fixture requires its owned disposable database');
 const email=`upgrade-diagnostic-${randomUUID()}@example.test`;
 const context=repositoryContext(workspaceScope(handles.workspaceId,{kind:'user',userId:handles.adminUserId,role:'admin'}),session);
 const mailbox=(await session.query<{id:string}>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,$3,$3,'connected') RETURNING id",[handles.workspaceId,handles.adminUserId,email])).rows[0]!;
 const policy=await readBusinessPolicy(context,mailbox.id);assert(policy?.accountBinding&&policy.generation);
 const observation=(await session.query<{id:string}>("INSERT INTO mailbox_oauth_grant_observations(workspace_id,mailbox_id,owner_user_id,provider_account_id,generation,granted_scopes) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",[handles.workspaceId,mailbox.id,handles.adminUserId,email,policy.generation,['https://www.googleapis.com/auth/gmail.readonly']])).rows[0]!;
 const record={...fixtureCiGateRecord('999999991'),enablesSending:false};
 const stored=await putReleaseRecord({db:session},record);assert(stored.ok,JSON.stringify(stored));
 const at=(await session.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at;
 const authorization:CrmAcquisitionDiagnosticAuthorization=crmAcquisitionDiagnosticAuthorizationSchema.parse({
  id:randomUUID(),purpose:'acquisition_acceptance',workspaceId:handles.workspaceId,mailboxId:mailbox.id,ownerUserId:handles.adminUserId,providerAccountId:email,accountBinding:policy.accountBinding,generation:policy.generation,oauthGrantObservationId:observation.id,environmentId:randomUUID(),databaseName:database,deploymentIdentity:'upgrade-controlled-api',workerDeploymentIdentity:'upgrade-controlled-worker',databaseInstanceArn:'upgrade-controlled-rds',databaseSecretArn:'upgrade-controlled-secret',databaseEndpoint:'upgrade-disposable.invalid',ecsClusterArn:'upgrade-controlled-cluster',implementationCommit:FIXTURE_CI_COMMIT,apiImageDigest:FIXTURE_API_DIGEST,workerImageDigest:FIXTURE_WORKER_DIGEST,schemaVersion:REQUIRED_SCHEMA,releaseReference:record.releaseGateReference,disclosureVersion:CRM_MAIL_CAPTURE_DISCLOSURE.version,disclosureSha256:CRM_MAIL_CAPTURE_DISCLOSURE.sha256,consentReference:'upgrade-controlled-read-only-consent',providerPolicyReference:'upgrade-controlled-no-external',reviewedBy:handles.adminUserId,reviewReference,verifiedAt:new Date(at.getTime()-1000).toISOString(),validUntil:new Date(at.getTime()+3600000).toISOString(),maxReads:4,maxUnits:42,metadataUnits:20,bodyUnits:20,messages:[{messageId:'upgrade_diagnostic_incoming',threadId:'upgrade_diagnostic_thread',origin:'received',fromAt:'2000-01-01T00:00:00Z',toAt:'2099-01-01T00:00:00Z'}]
 });
 const provisioned=await provisionCrmAcquisitionDiagnostic(session,authorization);assert(provisioned.ok);
 const historical={...authorization,id:randomUUID(),schemaVersion:90,reviewReference:`${reviewReference}-historical90`};
 await session.query('INSERT INTO crm_acquisition_diagnostic_authorizations(workspace_id,id,owner_user_id,mailbox_id,authorization_sha256,authorization_document,verified_at,valid_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[handles.workspaceId,historical.id,handles.adminUserId,mailbox.id,crmAcquisitionDiagnosticFingerprint(historical),JSON.stringify(historical),historical.verifiedAt,historical.validUntil]);
}

/** Real runtime domain request and registered worker over a fake external transport.
 * This is source upgrade proof only, not Gmail consent or provider acceptance. */
export async function runDiagnosticUpgradeWorkflow(context:RepositoryContext&{db:SessionQueryable}):Promise<string>{
 const tx=<Value>(run:()=>Promise<Value>)=>withTransaction(context.db,run);
 const documents=(await context.db.query<{authorization_document:unknown}>('SELECT authorization_document FROM crm_acquisition_diagnostic_authorizations WHERE workspace_id=$1 AND authorization_document->>\'reviewReference\' IN ($2,$3)',[context.scope.workspaceId,reviewReference,`${reviewReference}-historical90`])).rows.map(row=>crmAcquisitionDiagnosticAuthorizationSchema.parse(row.authorization_document));
 const current=documents.find(value=>value.schemaVersion===REQUIRED_SCHEMA);assert(current);
 const historical=documents.find(value=>value.schemaVersion===90);assert(historical);
 let isolationCalls=0;
 const runtime:CrmAcquisitionDiagnosticRuntime={environmentId:current.environmentId,implementationCommit:current.implementationCommit,imageDigest:current.apiImageDigest,side:'api',schemaVersion:REQUIRED_SCHEMA,verifyIsolation:async binding=>{isolationCalls++;return binding.databaseName===current.databaseName&&binding.environmentId===current.environmentId&&['upgrade-controlled-api','upgrade-controlled-worker'].includes(binding.deploymentIdentity);}};
 const obsoleteProof=await prepareCrmAcquisitionDiagnosticIsolation(context,{authorizationId:historical.id},runtime);
 assert.equal(obsoleteProof,null);
 const refused=await tx(()=>requestCrmAcquisitionDiagnostic(context,{authorizationId:historical.id,expectedAuthorizationSha256:crmAcquisitionDiagnosticFingerprint(historical)},runtime));
 assert.deepEqual(refused,{ok:false,reason:'diagnostic_authority_unavailable'});
 const witness=await prepareCrmAcquisitionDiagnosticIsolation(context,{authorizationId:current.id},runtime);assert(witness);
 const requested=await tx(()=>requestCrmAcquisitionDiagnostic(context,{authorizationId:current.id,expectedAuthorizationSha256:crmAcquisitionDiagnosticFingerprint(current)},runtime,witness));assert(requested.ok);
 const gmail=recordedGmailClient({emailAddress:current.providerAccountId,historyId:'10',messages:[{id:'upgrade_diagnostic_incoming',threadId:'upgrade_diagnostic_thread',historyId:'9',internalDateEpochMilliseconds:Date.parse('2026-10-10T15:00:00Z'),labelIds:['INBOX'],headers:{From:'correspondent@example.test',To:current.providerAccountId,Subject:'Synthetic upgrade diagnostic',Date:'Sat, 10 Oct 2026 15:00:00 +0000'},body:'Synthetic diagnostic original; no real correspondent or provider.'}]});
 const composition=createCrmAcquisitionDiagnosticCapture({runtime:{...runtime,side:'worker',imageDigest:current.workerImageDigest},transport:'controlled',gmail,openSession:async()=>({session:context.db,close:async()=>{}}),resolveAccess:async()=>({mailboxId:current.mailboxId,providerAccountId:current.providerAccountId,generation:current.generation,mailboxEmail:current.providerAccountId,access:{accessToken:'controlled-upgrade-no-credential',expiresAtEpochSeconds:4102444800}})});
 const registry=new HandlerRegistry();registry.register(businessMailCaptureHandler({provider:{read:async()=>{throw new Error('Ordinary acquisition is disabled');}},diagnostic:composition}));
 await runOnce(context.db,{registry,owner:'upgrade-current-diagnostic-worker',limit:100});
 const readWitness=await prepareCrmAcquisitionDiagnosticIsolation(context,{authorizationId:current.id},runtime,'progress_read');assert(readWitness);
 const report=await tx(()=>readCrmAcquisitionDiagnostic(context,{authorizationId:current.id},runtime,readWitness));assert(report);
 assert.equal(report.attemptedReads,4);assert.equal(report.observedUnits,42);assert.equal(report.conservedUnits,0);assert.equal(report.productionActivationAllowed,false);
 assert.equal(report.copies.length,1);assert.equal(report.copies[0]!.availability,'available');
 assert.equal(gmail.bodyReads.length,1);assert.equal(gmail.metadataReads.length,1);assert.equal(gmail.sends.length,0);assert(isolationCalls>0);
 assert.equal((await context.db.query('SELECT message_id FROM crm_acquisition_diagnostic_reads WHERE workspace_id=$1 AND authorization_id=$2',[context.scope.workspaceId,historical.id])).rows.length,0);
 assert.equal((await context.db.query("SELECT source_id FROM crm_mail_sources WHERE workspace_id=$1 AND diagnostic_authorization_id=$2 AND representation<>'plain_text'",[context.scope.workspaceId,current.id])).rows.length,0);
 return `current schema${REQUIRED_SCHEMA} migration-owned synthetic authority; runtime request/registered fake capture; four observed reads42 units, zero uncertain units and zero sends; old90 authority refuses new request/dispatch; no real provider or activation`;
}
