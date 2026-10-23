import type {AutomaticResearchTarget} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {automaticResearchNow} from '../sourcing/automaticResearchAuthority.ts';
import {listApplicableHolds} from '../policy/holds.ts';
import type {automaticResearchProof} from '../sourcing/automaticResearchProof.ts';

type Proof=NonNullable<Awaited<ReturnType<typeof automaticResearchProof>>>;
export interface AutomaticCampaignPublication extends Record<string,unknown>{id:string;revision:number;firm_id:string;candidate_id:string;candidate_revision:number;run_id:string;evidence_fingerprint:string;owner_user_id:string;source_kind:string;source_attempt_id:string;source_url:string}
export function automaticCampaignActor(ctx:RepositoryContext,owner:string):boolean{
 const actor=ctx.scope.actor;
 return actor.kind==='user'?actor.role==='admin'&&actor.userId===owner:actor.component==='worker'||actor.component==='scheduler';
}
export function automaticCampaignTarget(row:AutomaticCampaignPublication):AutomaticResearchTarget{
 return {kind:'automatic_research',publicationId:row.id,publicationRevision:row.revision,firmId:row.firm_id,candidateId:row.candidate_id,candidateRevision:row.candidate_revision,runId:row.run_id,evidenceFingerprint:row.evidence_fingerprint};
}
export function automaticCampaignPublicationMatches(row:AutomaticCampaignPublication,target:AutomaticResearchTarget,proof:Proof):boolean{
 return row.id===target.publicationId&&row.revision===target.publicationRevision&&row.firm_id===target.firmId&&row.candidate_id===target.candidateId&&row.candidate_revision===target.candidateRevision&&row.run_id===target.runId&&row.evidence_fingerprint===target.evidenceFingerprint&&proof.candidateId===row.candidate_id&&proof.candidateRevision===row.candidate_revision&&proof.runId===row.run_id&&proof.fingerprint===row.evidence_fingerprint&&proof.owner===row.owner_user_id&&proof.source.source.kind===row.source_kind&&proof.source.source.attemptId===row.source_attempt_id&&proof.source.source.sourceUrl===row.source_url;
}
/** Internal selection is never authority. No forged user scope, cache or reusable
 * authorization token: every use reloads the exact current publication and proof. */
export async function automaticCampaignSourceProof(ctx:RepositoryContext,target:AutomaticResearchTarget){
 // Lazy loading keeps automaticResearchProof -> selection -> campaign authority
 // free of a runtime initialization cycle. Only this invocation owns its snapshot.
 const {automaticResearchProof,automaticResearchIdentity}=await import('../sourcing/automaticResearchProof.ts');
 const read=async()=>(await ctx.db.query<AutomaticCampaignPublication>('SELECT * FROM sourcing_automatic_research_firms WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,target.publicationId])).rows[0];
 const row=await read();if(!row||!automaticCampaignActor(ctx,row.owner_user_id))return null;
 const proof=await automaticResearchProof(ctx,row.candidate_id);
 if(!proof||!automaticCampaignPublicationMatches(row,target,proof)||(await automaticResearchIdentity(ctx,proof.candidate,proof.owner))?.firmId!==row.firm_id)return null;
 const current=await read(),fresh=await automaticResearchProof(ctx,row.candidate_id);
 if(!current||!fresh||!automaticCampaignPublicationMatches(current,target,fresh)||(await automaticResearchIdentity(ctx,fresh.candidate,fresh.owner))?.firmId!==row.firm_id||(await listApplicableHolds(ctx,{actionKind:'research',channel:'research',ownerUserId:fresh.owner,firmId:row.firm_id})).length)return null;
 if(Date.parse(await automaticResearchNow(ctx))>=Date.parse(fresh.validUntil))return null;
 return {...fresh,firmId:row.firm_id,publicationId:row.id,publicationRevision:row.revision};
}
