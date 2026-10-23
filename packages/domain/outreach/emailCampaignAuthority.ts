import type {AutomaticResearchTarget,CandidateInput,EmailCampaign,EmailCampaignPolicy} from '@fss/contracts';
import {automaticResearchOwner} from '../sourcing/automaticResearchAuthority.ts';
import {automaticCampaignActor,automaticCampaignSourceProof} from './emailCampaignAutomatic.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {researchActor,readQualifiedResearchCandidate} from '../sourcing/qualifiedResearchProof.ts';
import {readCurrentDiscoveryResearchFirm} from '../sourcing/discoveryResearchFirm.ts';
import {authorizationForMailbox} from './authorization.ts';
import {campaignKind} from './settings.ts';
import {candidateIdentity} from '../sourcing/qualificationDecision.ts';
import type {QualificationRunRow} from '../sourcing/qualificationStore.ts';
import {supportedBusinessEmail,type EmailEvidenceRoute} from './selection.ts';
export type CurrentCampaignAuthority=()=>Promise<boolean>;
export async function campaignDatabaseNow(ctx:RepositoryContext):Promise<string>{const row=(await ctx.db.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0];if(!row)throw new Error('campaign_database_clock_unavailable');return row.now.toISOString();}
export interface EmailCampaignRow extends Record<string,unknown>{id:string;owner_user_id:string;mailbox_id:string;sequence_version_id:string;authorization_revision:number;regions:EmailCampaignPolicy['regions'];max_enrollments:number;daily_admission_limit:number;approved_at:Date;expires_at:Date;revision:number;revoked_at:Date|null}
export function campaignView(row:EmailCampaignRow,now:string,admittedCount:number):EmailCampaign{
 return {id:row.id,ownerUserId:row.owner_user_id,mailboxId:row.mailbox_id,sequenceVersionId:row.sequence_version_id,authorizationRevision:row.authorization_revision,regions:row.regions,maxEnrollments:row.max_enrollments,dailyAdmissionLimit:row.daily_admission_limit,approvedAt:row.approved_at.toISOString(),expiresAt:row.expires_at.toISOString(),revision:row.revision,revokedAt:row.revoked_at?.toISOString()??null,state:row.revoked_at?'revoked':row.expires_at.getTime()<=Date.parse(now)?'expired':'active',admittedCount};
}
export function campaignExpiryAllowed(expiresAt:string,now:string):boolean{
 const expiry=Date.parse(expiresAt),instant=Date.parse(now);return Number.isFinite(expiry)&&Number.isFinite(instant)&&expiry>instant&&expiry<=instant+30*86400000;
}
/** Caller already holds gate -> Today -> sourcing identity. Lock before Firm rows. */
export async function lockCurrentEmailCampaign(ctx:RepositoryContext):Promise<EmailCampaignRow|null>{
 const actor=ctx.scope.actor;
 const owner=actor.kind==='user'?actor.userId:actor.component==='migration'?null:await automaticResearchOwner(ctx);
 if(!owner)return null;
 return (await ctx.db.query<EmailCampaignRow>('SELECT * FROM outreach_email_campaigns WHERE workspace_id=$1 AND owner_user_id=$2 AND revoked_at IS NULL FOR UPDATE',[ctx.scope.workspaceId,owner])).rows[0]??null;
}
export async function currentEmailCampaign(ctx:RepositoryContext,id:string):Promise<EmailCampaignRow|null>{
 return (await ctx.db.query<EmailCampaignRow>('SELECT * FROM outreach_email_campaigns WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,id])).rows[0]??null;
}
/** A persisted audience approval is independent of content and mailbox permission. */
export async function campaignAuthorityCurrent(ctx:RepositoryContext,row:EmailCampaignRow,automaticSource?:AutomaticResearchTarget):Promise<boolean>{
 const actorCurrent=async()=>automaticSource?automaticCampaignActor(ctx,row.owner_user_id)&&(await automaticCampaignSourceProof(ctx,automaticSource))?.owner===row.owner_user_id:ctx.scope.actor.kind==='user'&&ctx.scope.actor.userId===row.owner_user_id&&await researchActor(ctx);
 if(!await actorCurrent()||row.revoked_at||row.expires_at.getTime()<=Date.parse(await campaignDatabaseNow(ctx)))return false;
 const auth=await authorizationForMailbox(ctx,row.mailbox_id);
 if(!auth.allowed||auth.revision!==row.authorization_revision||await campaignKind(ctx,row.sequence_version_id)!=='email_first')return false;
 const current=await currentEmailCampaign(ctx,row.id);
 return !!current&&current.owner_user_id===row.owner_user_id&&current.mailbox_id===row.mailbox_id&&current.sequence_version_id===row.sequence_version_id&&current.authorization_revision===row.authorization_revision&&current.revision===row.revision&&!current.revoked_at&&current.expires_at.getTime()>Date.parse(await campaignDatabaseNow(ctx))&&await actorCurrent();
}
/** No caller-supplied reviewed flag can manufacture this provenance. */
export async function campaignCandidateProvenance(ctx:RepositoryContext,input:{campaignId:string;candidateId:string;qualificationRunId:string},automaticSource?:AutomaticResearchTarget):Promise<{firmId:string;campaign:EmailCampaignRow;route:EmailEvidenceRoute}|null>{
 const campaign=await currentEmailCampaign(ctx,input.campaignId);if(!campaign||!await campaignAuthorityCurrent(ctx,campaign,automaticSource))return null;
 if(automaticSource){
  if(input.candidateId!==automaticSource.candidateId||input.qualificationRunId!==automaticSource.runId)return null;
  const proof=await automaticCampaignSourceProof(ctx,automaticSource);
  if(!proof||proof.owner!==campaign.owner_user_id||!campaign.regions.some(region=>region===proof.candidate.region)||!await campaignAuthorityCurrent(ctx,campaign,automaticSource))return null;
  const checkedAt=await campaignDatabaseNow(ctx);
  return Date.parse(checkedAt)<Math.min(Date.parse(proof.validUntil),campaign.expires_at.getTime())?{firmId:proof.firmId,campaign,route:proof.route}:null;
 }
 const rows=(await ctx.db.query<{firm_id:string}>(`SELECT l.firm_id FROM sourcing_discovery_research_firms l JOIN sourcing_discovery_promotions p ON p.workspace_id=l.workspace_id AND p.id=l.promotion_id WHERE l.workspace_id=$1 AND p.legacy_candidate_id=$2`,[ctx.scope.workspaceId,input.candidateId])).rows;
 if(rows.length!==1)return null;
 const lineage=await readCurrentDiscoveryResearchFirm(ctx,{firmId:rows[0]!.firm_id});if(!lineage)return null;
 const proof=await readQualifiedResearchCandidate(ctx,lineage.discoveryCandidateId);
 if(!proof||Date.parse(proof.validUntil)<=Date.parse(await campaignDatabaseNow(ctx))||proof.selection.candidateId!==input.candidateId||proof.selection.runId!==input.qualificationRunId||proof.emailFit!=='eligible'||!campaign.regions.some(region=>region===proof.region)||lineage.firm.region_code!==proof.region||lineage.firm.locality!==proof.locality)return null;
 const evidence=(await ctx.db.query<QualificationRunRow & {campaign_candidate_payload:CandidateInput}>(`SELECT r.*,c.payload AS campaign_candidate_payload FROM sourcing_qualification_runs r JOIN sourcing_candidates c ON c.workspace_id=r.workspace_id AND c.id=r.candidate_id AND c.revision=r.candidate_revision AND NOT c.qualification_blocked AND c.status<>'dismissed' WHERE r.workspace_id=$1 AND r.candidate_id=$2 AND r.id=$3`,[ctx.scope.workspaceId,input.candidateId,input.qualificationRunId])).rows[0];if(!evidence)return null;
 const current=await readCurrentDiscoveryResearchFirm(ctx,{firmId:lineage.firm.id});
 if(!current||current.promotionId!==lineage.promotionId||current.candidate.revision!==proof.selection.candidateRevision||!await campaignAuthorityCurrent(ctx,campaign))return null;
 // This is deliberately the last await. Native citation expiry does not cover an
 // independent email observation, and transaction-start emailFit is not fresh proof.
 const checkedAt=await campaignDatabaseNow(ctx);
 if(Date.parse(checkedAt)>=Math.min(Date.parse(proof.validUntil),campaign.expires_at.getTime()))return null;
 const route=supportedBusinessEmail({identity:candidateIdentity(evidence.campaign_candidate_payload,evidence.facts,evidence.observations),facts:evidence.facts,observations:evidence.observations,now:checkedAt});
 return route?{firmId:lineage.firm.id,campaign,route}:null;
}
