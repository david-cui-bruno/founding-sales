import {createHash} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import type {QualificationFact,SourceObservation} from '@fss/contracts';
import {preparedSourceIdentityPgFixture} from './preparedSourceIdentityPgFixture.ts';
import {preparedIdentityCitationRoles,PREPARED_IDENTITY_PRODUCER,LEGACY_QUALIFICATION_PRODUCER} from '../../sourcing/preparedIdentity.ts';
import {finishQualification} from '../../sourcing/qualificationStore.ts';
import {QUALIFICATION_PROMPT_VERSION} from '../../sourcing/qualificationVersions.ts';
import {QUALIFICATION_MODEL_NAME} from '../../sourcing/qualificationModel.ts';
import {withTransaction} from '../../db/queryable.ts';
import {repositoryContext} from '../../db/workspaceScope.ts';
import {advanceAutomaticResearchFirm,readAutomaticResearchFirm} from '../../sourcing/automaticResearch.ts';
import {automaticResearchProof} from '../../sourcing/automaticResearchProof.ts';
import {admitCandidate} from '../../sourcing/admission.ts';

let f:Awaited<ReturnType<typeof preparedSourceIdentityPgFixture>>;
beforeEach(async()=>{f=await preparedSourceIdentityPgFixture();});
afterEach(async()=>f?.drop());
function evidence(retrievedAt=new Date().toISOString()){
 const id='11111111-1111-4111-8111-111111111111',description=`${f.name} manages residential homes in Boston, Massachusetts.`,email=`Contact ${f.name} office in Boston, MA at info@${new URL(f.website).hostname}.`;
 const observations:SourceObservation[]=[{id,url:f.website,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt,publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[{id:'identity',text:f.name},{id:'service',text:description},{id:'email',text:email}]}];
 const facts:QualificationFact[]=[{kind:'firm_identity',value:f.name,observationId:id,blockId:'identity'},...(['residential_management','service_area'] as const).map(kind=>({kind,value:description,observationId:id,blockId:'service'})),{kind:'business_email',value:email,observationId:id,blockId:'email'}];
 const interpreted=preparedIdentityCitationRoles(f.candidate,facts,observations,PREPARED_IDENTITY_PRODUCER);
 if(!interpreted.ok||!interpreted.preparedIdentity)throw Error('Prepared identity fixture must derive opaque source proof');
 return {facts:interpreted.facts,observations,preparedIdentity:interpreted.preparedIdentity};
}
async function completed(retrievedAt?:string){
 const runId=await f.request(),input=evidence(retrievedAt);
 expect(await withTransaction(f.runtime,()=>finishQualification(f.worker,{runId,...input,reason:null,openingQuestion:null}))).toEqual({ok:true,value:{runId}});
 await withTransaction(f.runtime,()=>advanceAutomaticResearchFirm(f.worker,{runId},'prepare_before_legacy'));
 const row=await f.publication();if(!row)throw Error('Prepared identity fixture must publish');
 return {runId,row,input};
}

it('reuses a same-day legacy fingerprint before choosing a producer, without minting a second attempt or changing old bytes',async()=>{
 const old=await f.request(f.admin),before=await f.run(old);
 expect(before.producer_version).toBe(LEGACY_QUALIFICATION_PRODUCER);
 expect(await f.request()).toBe(old);expect(await f.run(old)).toEqual(before);
 const at=(await f.runtime.query<{utc_date:string}>("SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD') AS utc_date")).rows[0]!.utc_date;
 expect(before.fingerprint).toBe(createHash('sha256').update(JSON.stringify([1,QUALIFICATION_PROMPT_VERSION,'qualification-v5',QUALIFICATION_MODEL_NAME,at])).digest('hex'));
 expect((await f.runtime.query('SELECT id FROM sourcing_qualification_runs WHERE workspace_id=$1',[f.workspace])).rows).toHaveLength(1);
 expect((await f.runtime.query('SELECT id FROM provider_reservations WHERE workspace_id=$1',[f.workspace])).rows).toHaveLength(0);
});

it.each(['missing_source','owner_inactive','owner_not_admin','not_automatic'] as const)('stamps legacy mode for %s instead of treating a search label as new authority',async cause=>{
 if(cause==='missing_source')await f.database.session.query('UPDATE sourcing_discovery_hits SET candidate_id=NULL WHERE workspace_id=$1',[f.workspace]);
 if(cause==='owner_inactive')await f.deactivateOwner();
 if(cause==='owner_not_admin'){await f.backupAdmin();await f.database.session.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",[f.workspace,f.owner]);}
 if(cause==='not_automatic')await f.database.session.query('UPDATE sourcing_discovery_settings SET auto_admission_enabled=false WHERE workspace_id=$1',[f.workspace]);
 expect((await f.run(await f.request())).producer_version).toBe(LEGACY_QUALIFICATION_PRODUCER);
});

it('persists only an exact opaque proof on completion, refuses tampered proof and forbids changing producer or completed metadata',async()=>{
 const runId=await f.request(),input=evidence();
 expect(await withTransaction(f.runtime,()=>finishQualification(f.worker,{runId,...input,preparedIdentity:{...input.preparedIdentity,blockTextHash:'d'.repeat(64)},reason:null}))).toEqual({ok:false,reason:'invalid_evidence'});
 expect((await f.run(runId)).prepared_identity).toBeNull();
 await expect(f.runtime.query("UPDATE sourcing_qualification_runs SET producer_version='qualification-context-v7' WHERE workspace_id=$1 AND id=$2",[f.workspace,runId])).rejects.toMatchObject({code:'23514',constraint:'sourcing_qualification_producer_immutable'});
 await expect(f.runtime.query('UPDATE sourcing_qualification_runs SET prepared_identity=$3::jsonb WHERE workspace_id=$1 AND id=$2',[f.workspace,runId,JSON.stringify(input.preparedIdentity)])).rejects.toMatchObject({code:'23514',constraint:'sourcing_qualification_prepared_identity_immutable'});
 expect(await withTransaction(f.runtime,()=>finishQualification(f.worker,{runId,...input,reason:null}))).toMatchObject({ok:true});
 const before=await f.run(runId);expect(Object.keys(input.preparedIdentity).sort()).toEqual(['blockId','blockTextHash','contentHash','observationId','producerVersion','relevantTextHash']);
 await expect(f.runtime.query('UPDATE sourcing_qualification_runs SET prepared_identity=NULL WHERE workspace_id=$1 AND id=$2',[f.workspace,runId])).rejects.toMatchObject({code:'23514',constraint:'sourcing_qualification_prepared_identity_immutable'});
 expect(await f.run(runId)).toEqual(before);
});

it.each(['source_loss','owner_revoked','candidate_revision','newer_run','erased_source'] as const)('current prepared read refuses %s without falling back to the stored title or rewriting the proof',async cause=>{
 const {runId,row}=await completed(),before=(await f.run(runId)).prepared_identity;
 expect(await readAutomaticResearchFirm(f.admin,row.id)).toMatchObject({firmName:f.name});
 if(cause==='source_loss')await f.database.session.query('UPDATE sourcing_discovery_hits SET candidate_id=NULL WHERE workspace_id=$1',[f.workspace]);
 if(cause==='owner_revoked')await f.deactivateOwner();
 if(cause==='candidate_revision')await f.database.session.query('UPDATE sourcing_candidates SET revision=revision+1 WHERE workspace_id=$1 AND id=$2',[f.workspace,f.candidate.id]);
 if(cause==='newer_run')await f.database.session.query(`INSERT INTO sourcing_qualification_runs(workspace_id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name,requested_at,deadline_at)
  VALUES($1,$2,1,repeat('d',64),'qualification-context-v7','qualification-v5','claude-haiku-4-5',now()+interval '1 second',now()+interval '31 minutes')`,[f.workspace,f.candidate.id]);
 if(cause==='erased_source')await f.database.session.query("UPDATE sourcing_qualification_runs SET observations='[]'::jsonb,facts='[]'::jsonb WHERE workspace_id=$1 AND id=$2",[f.workspace,runId]);
 expect(await readAutomaticResearchFirm(f.admin,row.id)).toBeNull();expect((await f.run(runId)).prepared_identity).toEqual(before);
});

it('rechecks real wall-clock expiry after a current-read wait inside an open transaction',async()=>{
 const until=Date.now()+2500,{row}=await completed(new Date(until-7*86400000).toISOString());
 let waited=false;
 const paused=repositoryContext(f.admin.scope,{query:async(sql,values)=>{
  if(!waited&&sql.includes('SELECT id, name, website FROM firms')){waited=true;await new Promise(resolve=>setTimeout(resolve,Math.max(0,until-Date.now()+40)));}
  return f.runtime.query(sql,values);
 }});
 expect(await withTransaction(f.runtime,()=>readAutomaticResearchFirm(paused,row.id))).toBeNull();expect(waited).toBe(true);
});

it('does not let a source-derived prepared run enter legacy reviewed admission',async()=>{
 const {runId}=await completed();
 expect(await automaticResearchProof(f.worker,f.candidate.id)).not.toBeNull();
 const admitted=await withTransaction(f.runtime,()=>admitCandidate(f.admin,{candidateId:f.candidate.id,expectedRevision:1,qualificationRunId:runId,mode:'reviewed'}));
 expect(admitted.ok).toBe(false);
 expect((await f.runtime.query('SELECT candidate_id FROM sourcing_admissions WHERE workspace_id=$1',[f.workspace])).rows).toHaveLength(0);
});
