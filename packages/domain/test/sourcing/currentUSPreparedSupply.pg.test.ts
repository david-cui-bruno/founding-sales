import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTransaction} from '../../db/queryable.ts';
import {createFirm} from '../../crm/firms.ts';
import {advanceAutomaticResearchFirm,readAutomaticResearchFirm} from '../../sourcing/automaticResearch.ts';
import {automaticResearchProof} from '../../sourcing/automaticResearchProof.ts';
import {advanceVerifiedFirm} from '../../sourcing/verifiedFirmPipeline.ts';
import {isCurrentPreparedCandidatePayload,isLegacyCandidatePayload} from '../../sourcing/discoveryIntake.ts';
import {targetingProposalSchema} from '@fss/contracts';
import {readTargetingPolicy,saveTargetingProposal,applyTargetingProposal} from '../../sourcing/targetingProposals.ts';
import {currentUSPreparedSupplyPgFixture} from './currentUSPreparedSupplyPgFixture.ts';
import {supportedBusinessEmail} from '../../outreach/selection.ts';
let f:Awaited<ReturnType<typeof currentUSPreparedSupplyPgFixture>>;
beforeAll(async()=>{f=await currentUSPreparedSupplyPgFixture();});
afterAll(async()=>f?.drop());
const sending=async()=>(await f.database.session.query("SELECT * FROM workspace_settings WHERE setting_key='sending_enabled' ORDER BY workspace_id,version")).rows;
it('uses current CA intake and qualification owners to publish/read an explicit us-v1 research Firm while legacy admission and sending stay closed',async()=>{
 const current=await f.prepared(),before=await sending();
 const candidate=(await f.runtime.query('SELECT payload FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2',[f.seed.alpha.workspaceId,current.candidateId])).rows[0]?.['payload'];
 expect(isCurrentPreparedCandidatePayload(candidate)).toBe(true);expect(isLegacyCandidatePayload(candidate)).toBe(false);
 await withTransaction(f.runtime,()=>advanceVerifiedFirm(f.worker,{runId:current.runId}));
 expect((await f.runtime.query('SELECT * FROM sourcing_admissions WHERE workspace_id=$1 AND candidate_id=$2',[f.seed.alpha.workspaceId,current.candidateId])).rows).toEqual([]);
 await withTransaction(f.runtime,()=>advanceAutomaticResearchFirm(f.worker,{runId:current.runId},'prepare_before_legacy'));
 const publication=(await f.runtime.query<{id:string;native_policy_version:string}>('SELECT id,native_policy_version FROM sourcing_automatic_research_firms WHERE workspace_id=$1 AND candidate_id=$2',[f.seed.alpha.workspaceId,current.candidateId])).rows[0];
 expect(publication?.native_policy_version).toBe('native-firm-eligibility-us-v1');
 if(!publication)throw new Error('Current US publication missing');
 expect(await readAutomaticResearchFirm(f.admin,publication.id)).toMatchObject({region:'CA',nativePolicyVersion:'native-firm-eligibility-us-v1',
  target:{candidateId:current.candidateId,runId:current.runId},channelAuthority:'not_granted'});
 expect(await sending()).toEqual(before);
 for(const table of ['outbound_messages','provider_reservations','sourcing_admissions','phone_routes'])
  expect((await f.runtime.query(`SELECT count(*)::int n FROM ${table} WHERE workspace_id=$1`,[f.seed.alpha.workspaceId])).rows[0]?.['n']).toBe(0);
});
it('holds a legacy-v1 stored publication instead of reinterpreting or refreshing it as new current US coverage',async()=>{
 const current=await f.prepared(),proof=await automaticResearchProof(f.worker,current.candidateId);
 if(!proof)throw new Error('Controlled current US proof missing');
 const made=await withTransaction(f.runtime,()=>createFirm(f.admin,{name:current.firmName,website:current.website,
  locality:current.locality,regionCode:current.region,assignedUserId:f.seed.alpha.admin.userId,researchAlreadyQualified:true}));
 if(!made.ok)throw new Error(made.reason);
 const id=randomUUID();
 await f.runtime.query(`INSERT INTO sourcing_automatic_research_firms(workspace_id,id,candidate_id,run_id,candidate_revision,firm_id,owner_user_id,
  source_kind,source_url,source_attempt_id,search_source_url,search_attempt_id,evidence_fingerprint,native_policy_version)
  VALUES($1,$2,$3,$4,1,$5,$6,'search_hit',$7,$8,$7,$8,$9,'native-firm-eligibility-v1')`,
 [f.seed.alpha.workspaceId,id,current.candidateId,current.runId,made.value.id,f.seed.alpha.admin.userId,current.website,current.attempt,proof.fingerprint]);
 const read=async()=>(await f.runtime.query('SELECT * FROM sourcing_automatic_research_firms WHERE workspace_id=$1 AND id=$2',[f.seed.alpha.workspaceId,id])).rows;
 const before=await read();expect(await readAutomaticResearchFirm(f.admin,id)).toBeNull();
 await withTransaction(f.runtime,()=>advanceAutomaticResearchFirm(f.worker,{runId:current.runId},'prepare_before_legacy'));
 expect(await read()).toEqual(before);expect(await readAutomaticResearchFirm(f.admin,id)).toBeNull();
});
it('keeps the exact acquisition fingerprint across rank-only approval while fencing the current epoch',async()=>{
 const current=await f.prepared(),before=await automaticResearchProof(f.worker,current.candidateId);expect(before).not.toBeNull();
 const policy=await readTargetingPolicy(f.admin);
 const proposed=await withTransaction(f.runtime,()=>saveTargetingProposal(f.admin,targetingProposalSchema.parse({basePolicyVersion:policy.version,
  queryChanges:[],rankOrder:policy.rankOrder,evidenceIds:[],rationale:'Controlled fictional superseding policy preserves historical attempt identity.'})));
 if(!proposed.ok)throw new Error(proposed.reason);
 const applied=await withTransaction(f.runtime,()=>applyTargetingProposal(f.admin,{id:proposed.value.id,expectedRevision:proposed.value.revision}));
 if(!applied.ok)throw new Error(applied.reason);
 const after=await automaticResearchProof(f.worker,current.candidateId);
 expect(after?.fingerprint).toBe(before?.fingerprint);expect(after?.targetingVersion).toBe(applied.value.policyVersion);
 expect(after?.targetingVersion).not.toBe(before?.targetingVersion);
});
it.each(['may provide','plans to provide','intends to provide','will provide','would provide'])('holds future-only current US evidence and creates no publication despite a valid independent office email: %s',async action=>{
 const current=await f.prepared(action),before=await sending();
 expect(supportedBusinessEmail({identity:{status:'resolved',name:current.firmName,website:current.website,
  locality:current.locality,region:current.region},...current.evidence})).toMatchObject({address:`info@${new URL(current.website).hostname}`});
 expect(await automaticResearchProof(f.worker,current.candidateId)).toBeNull();
 await withTransaction(f.runtime,()=>advanceAutomaticResearchFirm(f.worker,{runId:current.runId},'prepare_before_legacy'));
 expect((await f.runtime.query('SELECT id FROM sourcing_automatic_research_firms WHERE workspace_id=$1 AND candidate_id=$2',
  [f.seed.alpha.workspaceId,current.candidateId])).rows).toEqual([]);
 expect(await sending()).toEqual(before);
});
