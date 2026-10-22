import {automaticResearchFirmSchema,type AutomaticResearchFirm} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor} from '../crm/identityAccess.ts';
import {createFirm,loadFirmForUpdate} from '../crm/firms.ts';
import {canonicalWebsite} from '../crm/import.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {lockTodayForFirmChange} from '../today/build.ts';
import {automaticResearchNow} from './automaticResearchAuthority.ts';
import {automaticResearchIdentity,automaticResearchProof} from './automaticResearchProof.ts';
import {canonicalResearchValue} from './qualifiedResearchProof.ts';
interface Publication {id:string;candidate_id:string;candidate_revision:number;run_id:string;revision:number;firm_id:string;owner_user_id:string;source_kind:'search_hit'|'apollo_organization';source_url:string;source_attempt_id:string;evidence_fingerprint:string;[key:string]:unknown}
const publication=async(ctx:RepositoryContext,id:string)=>(await ctx.db.query<Publication>('SELECT * FROM sourcing_automatic_research_firms WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,id])).rows[0]??null;
const sourceMatches=(row:Publication,proof:NonNullable<Awaited<ReturnType<typeof automaticResearchProof>>>)=>row.owner_user_id===proof.owner&&row.source_kind===proof.source.source.kind&&row.source_attempt_id===proof.source.source.attemptId&&row.source_url===proof.source.source.sourceUrl;
/** Caller owns the transaction. Atomic refusal rolls back even canonical Firm creation. */
export async function advanceAutomaticResearchFirm(ctx:RepositoryContext,input:{runId:string}):Promise<void>{
 if(ctx.scope.actor.kind!=='system'||!['worker','scheduler'].includes(ctx.scope.actor.component))return;
 await lockSendGateForStopFact(ctx);await lockTodayForFirmChange(ctx);
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sourcing-identity:${ctx.scope.workspaceId}`]);
 await ctx.db.query('SAVEPOINT automatic_research_publication');
 try{
  const ok=await publish(ctx,input.runId);if(!ok)await ctx.db.query('ROLLBACK TO SAVEPOINT automatic_research_publication');
  await ctx.db.query('RELEASE SAVEPOINT automatic_research_publication');
 }catch(error){
  await ctx.db.query('ROLLBACK TO SAVEPOINT automatic_research_publication');await ctx.db.query('RELEASE SAVEPOINT automatic_research_publication');
  // Source/Firm deletion can win a foreign-key wait. A competing identity can
  // win uniqueness. Both are internal refusals, never provider retry requests.
  if(error!==null&&typeof error==='object'&&'code' in error&&['23503','23505'].includes(String(error.code)))return;
  throw error;
 }
}
async function publish(ctx:RepositoryContext,runId:string):Promise<boolean>{
 const w=ctx.scope.workspaceId;
 const run=(await ctx.db.query<{candidate_id:string}>('SELECT candidate_id FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=$2',[w,runId])).rows[0];if(!run)return false;
 const initial=await automaticResearchProof(ctx,run.candidate_id);if(!initial||initial.runId!==runId)return false;
 // A deleted current link is not an unfinished publication. Retain only the
 // ordinary IDs-only immutable audit identity, never recreate a privately deleted Firm.
 const deleted=(await ctx.db.query(`SELECT 1 FROM audit_events a WHERE a.workspace_id=$1 AND a.action='sourcing.automatic_research_published' AND a.detail->>'candidateId'=$2::text AND NOT EXISTS(SELECT 1 FROM sourcing_automatic_research_firms p WHERE p.workspace_id=a.workspace_id AND p.candidate_id=$2::uuid) LIMIT 1`,[w,run.candidate_id])).rows.length>0;
 if(deleted)return false;
 const identity=await automaticResearchIdentity(ctx,initial.candidate,initial.owner);if(!identity)return false;
 let firm=identity.firmId?await loadFirmForUpdate(ctx,identity.firmId):null;if(identity.firmId&&!firm)return false;
 if(!firm){const made=await createFirm(ctx,{name:initial.candidate.firmName.trim().replaceAll(/\s+/gu,' '),website:canonicalWebsite(initial.candidate.website)??initial.candidate.website,locality:initial.candidate.locality,regionCode:initial.candidate.region,assignedUserId:initial.owner,researchAlreadyQualified:true});if(!made.ok)return false;firm=made.value;}
 await ctx.db.query('SELECT id FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,run.candidate_id]);
 await ctx.db.query('SELECT id FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,runId]);
 const current=await automaticResearchProof(ctx,run.candidate_id);
 if(!current||current.fingerprint!==initial.fingerprint||(await automaticResearchIdentity(ctx,current.candidate,current.owner))?.firmId!==firm.id)return false;
 const prior=(await ctx.db.query<Publication>('SELECT * FROM sourcing_automatic_research_firms WHERE workspace_id=$1 AND candidate_id=$2 FOR UPDATE',[w,current.candidateId])).rows[0];
 if(prior&&(!sourceMatches(prior,current)||prior.firm_id!==firm.id))return false;
 let id=prior?.id;
 if(!prior){
  const source=current.source.source;
  id=(await ctx.db.query<{id:string}>(`INSERT INTO sourcing_automatic_research_firms(workspace_id,candidate_id,run_id,candidate_revision,firm_id,owner_user_id,source_kind,source_url,source_attempt_id,search_source_url,search_attempt_id,apollo_origin_revision,apollo_attempt_id,evidence_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,[w,current.candidateId,current.runId,current.candidateRevision,firm.id,current.owner,source.kind,source.sourceUrl,source.attemptId,source.kind==='search_hit'?source.sourceUrl:null,source.kind==='search_hit'?source.attemptId:null,current.source.originRevision,source.kind==='apollo_organization'?source.attemptId:null,current.fingerprint])).rows[0]!.id;
 }else if(prior.evidence_fingerprint!==current.fingerprint){
  await ctx.db.query('UPDATE sourcing_automatic_research_firms SET run_id=$3,candidate_revision=$4,evidence_fingerprint=$5,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',[w,id,current.runId,current.candidateRevision,current.fingerprint]);
 }
 if(!prior||prior.evidence_fingerprint!==current.fingerprint)await recordCrmAuditEvent(ctx,{action:'sourcing.automatic_research_published',subjectKind:'firm',subjectId:firm.id,detail:{publicationId:id!,candidateId:current.candidateId,runId:current.runId,candidateRevision:current.candidateRevision,revision:(prior?.revision??0)+1,sourceKind:current.source.source.kind,sourceAttemptId:current.source.source.attemptId,policyVersion:'automatic-research-v1'}});
 // Audit/creation/row locks may have waited: independently reevaluate email AND native proof now.
 const final=await automaticResearchProof(ctx,current.candidateId);
 return final?.fingerprint===current.fingerprint&&(await automaticResearchIdentity(ctx,final.candidate,final.owner))?.firmId===firm.id&&Date.parse(await automaticResearchNow(ctx))<Date.parse(final.validUntil);
}
/** Private current read only. No creation, replay, dispatch or name fallback. */
export async function readAutomaticResearchFirm(ctx:RepositoryContext,publicationId:string):Promise<AutomaticResearchFirm|null>{
 const actor=ctx.scope.actor;if(actor.kind!=='user'||actor.role!=='admin'||!await activeIdentityActor(ctx))return null;
 const row=await publication(ctx,publicationId);if(!row||row.owner_user_id!==actor.userId)return null;
 const proof=await automaticResearchProof(ctx,row.candidate_id);
 if(!proof||!sourceMatches(row,proof)||row.run_id!==proof.runId||row.candidate_revision!==proof.candidateRevision||row.evidence_fingerprint!==proof.fingerprint||(await automaticResearchIdentity(ctx,proof.candidate,proof.owner))?.firmId!==row.firm_id)return null;
 const current=await publication(ctx,publicationId),fresh=await automaticResearchProof(ctx,row.candidate_id);
 if(!current||canonicalResearchValue(current)!==canonicalResearchValue(row)||fresh?.fingerprint!==proof.fingerprint||(await automaticResearchIdentity(ctx,fresh.candidate,fresh.owner))?.firmId!==row.firm_id||!await activeIdentityActor(ctx))return null;
 const checkedAt=await automaticResearchNow(ctx);if(Date.parse(checkedAt)>=Date.parse(fresh.validUntil))return null;
 return automaticResearchFirmSchema.parse({target:{kind:'automatic_research',publicationId:row.id,publicationRevision:row.revision,firmId:row.firm_id,candidateId:row.candidate_id,candidateRevision:row.candidate_revision,runId:row.run_id,evidenceFingerprint:row.evidence_fingerprint},source:fresh.source.source,ownerUserId:fresh.owner,firmName:fresh.candidate.firmName,website:fresh.candidate.website,locality:fresh.candidate.locality,region:fresh.candidate.region,policyVersion:'automatic-research-v1',nativePolicyVersion:'native-firm-eligibility-v1',checkedAt,validUntil:fresh.validUntil,citations:fresh.citations,emailFit:'eligible',channelAuthority:'not_granted',maintenanceNeed:'not_established',nextStep:'prepare_discovery_conversation',question:'What would be useful to learn about this firm before considering a discovery conversation?'});
}
