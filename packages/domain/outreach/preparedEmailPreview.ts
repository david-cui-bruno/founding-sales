import type {EmailCampaignPreparedPreview} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {listPreparedEmailCandidates} from '../sourcing/preparedEmailRead.ts';
import {preparedCandidatePayload} from '../sourcing/discoveryIntake.ts';
import {researchActor} from '../sourcing/qualifiedResearchProof.ts';
import {latestEmailVerification} from './emailVerification.ts';
import {admittedCandidateIds,preparedEmailAccept} from './preparedEmailSelection.ts';

/** ADR0035. Who the next admission pass would take, in admission order: the same list, skip set and `accept` filter the worker uses, plus
 * each address's latest stored check. A read only: it never runs the verifier, records a check, admits, locks or enqueues. Admin only. */
export async function previewPreparedEmailAdmission(ctx:RepositoryContext,input:{limit:number;regions:readonly string[]}):Promise<EmailCampaignPreparedPreview|null>{
 if(!await researchActor(ctx))return null;
 const reads=await listPreparedEmailCandidates(ctx,{...input,skip:await admittedCandidateIds(ctx),accept:await preparedEmailAccept(ctx,null)}),candidates:EmailCampaignPreparedPreview['candidates']=[];
 for(const read of reads){
  const candidate=(await ctx.db.query<{payload:unknown}>('SELECT payload FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,read.candidateId])).rows[0],payload=candidate&&preparedCandidatePayload(candidate.payload);
  if(!payload)continue;
  const recorded=await latestEmailVerification(ctx,read.route.address);
  candidates.push({candidateId:read.candidateId,host:read.host,companyName:read.businessName,website:payload.website,locality:read.locality,region:read.region as EmailCampaignPreparedPreview['candidates'][number]['region'],address:read.route.address,verification:recorded&&{result:recorded.result,outcome:recorded.outcome,checkedAt:recorded.checkedAt.toISOString()}});
 }
 return {candidates};
}
