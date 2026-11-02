import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {PreparedEmailRead} from '../sourcing/preparedEmailRead.ts';
import {droppedEmailAddressKeys,emailVerificationKey} from './emailVerification.ts';
import {preparedAdmissionRefusedInAdvance} from './preparedEmailAssessment.ts';

/** Candidate ids already admitted to any campaign: the selection skips them. A fresh, mutable set the caller may add to. */
export const admittedCandidateIds=async(ctx:RepositoryContext):Promise<Set<string>>=>new Set((await ctx.db.query<{candidate_id:string}>('SELECT candidate_id FROM outreach_email_campaign_admissions WHERE workspace_id=$1',[ctx.scope.workspaceId])).rows.map(row=>row.candidate_id));
/** The ONE selection-time `accept` filter shared by the worker's admission pass and the admin preview (ADR0035): a recorded invalid
 * answer inside its window, and the deterministic refusals admission would repeat (existing Firm, unresolvable zone, email stop).
 * `campaignId` is null when no campaign is involved (the preview). Dropped keys are read once per filter; refusals are memoized per candidate. */
export async function preparedEmailAccept(ctx:RepositoryContext,campaignId:string|null):Promise<(read:PreparedEmailRead)=>Promise<boolean>>{
 const dropped=await droppedEmailAddressKeys(ctx),refusedInAdvance=new Map<string,boolean>();
 return async read=>{
  if(dropped.has(emailVerificationKey(read.route.address)))return false;
  let refused=refusedInAdvance.get(read.candidateId);
  if(refused===undefined){refused=await preparedAdmissionRefusedInAdvance(ctx,campaignId,read);refusedInAdvance.set(read.candidateId,refused);}
  return !refused;
 };
}
