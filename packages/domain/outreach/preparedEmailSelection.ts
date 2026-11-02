import type {RepositoryContext} from '../db/workspaceScope.ts';
import {listPreparedEmailCandidates,type PreparedEmailRead} from '../sourcing/preparedEmailRead.ts';
import {droppedEmailAddressKeys,emailVerificationKey} from './emailVerification.ts';
import {preparedAdmissionRefusedInAdvance} from './preparedEmailAssessment.ts';
import {currentPeopleContacts,type PeopleContact} from './peopleContacts.ts';

/** Candidate ids already admitted to any campaign: the selection skips them. A fresh, mutable set the caller may add to. */
export const admittedCandidateIds=async(ctx:RepositoryContext):Promise<Set<string>>=>new Set((await ctx.db.query<{candidate_id:string}>('SELECT candidate_id FROM outreach_email_campaign_admissions WHERE workspace_id=$1',[ctx.scope.workspaceId])).rows.map(row=>row.candidate_id));
/** A prepared company and the current provider person it would be admitted with (ADR0036). */
export interface PreparedEmailChoice {read:PreparedEmailRead;person:PeopleContact}
/** The ONE selection the worker's admission pass and the admin preview share: prepared companies, in the prepared list's order and one per
 * host, that have a current found provider person for exactly this revision, whose address has no recorded invalid check inside its
 * window, and that admission would not refuse in advance (existing Firm, unresolvable zone, an effective email stop on the person's address).
 * `campaignId` is null when no campaign is involved (the preview). Refusals are memoized per candidate. */
export async function listPreparedEmailChoices(ctx:RepositoryContext,input:{limit:number;regions:readonly string[];skip:ReadonlySet<string>;campaignId:string|null}):Promise<PreparedEmailChoice[]>{
 const [dropped,people]=await Promise.all([droppedEmailAddressKeys(ctx),currentPeopleContacts(ctx)]),refused=new Map<string,boolean>(),chosen=new Map<string,PeopleContact>();
 const reads=await listPreparedEmailCandidates(ctx,{limit:input.limit,regions:input.regions,skip:input.skip,accept:async read=>{
  const person=people.get(read.candidateId);
  if(!person||person.candidateRevision!==read.candidateRevision||person.host!==read.host||dropped.has(emailVerificationKey(person.email)))return false;
  let stop=refused.get(read.candidateId);
  if(stop===undefined){stop=await preparedAdmissionRefusedInAdvance(ctx,input.campaignId,read,person.email);refused.set(read.candidateId,stop);}
  if(stop)return false;
  chosen.set(read.candidateId,person);return true;
 }});
 return reads.map(read=>({read,person:chosen.get(read.candidateId)!}));
}
