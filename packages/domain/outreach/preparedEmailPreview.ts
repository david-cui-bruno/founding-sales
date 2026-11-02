import type {EmailCampaignPreparedPreview} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {preparedCandidatePayload} from '../sourcing/discoveryIntake.ts';
import {researchActor} from '../sourcing/qualifiedResearchProof.ts';
import {latestEmailVerification} from './emailVerification.ts';
import {countAwaitingEnrichment} from './peopleEnrichment.ts';
import {countNamedWithoutEmail} from './peopleContacts.ts';
import {admittedCandidateIds,listPreparedEmailChoices} from './preparedEmailSelection.ts';

/** ADR0035/0036/0037. Who the next admission pass would take, in admission order: the same list, skip set and selection the worker uses, with each
 * company's named person (name, title, address, status, match confidence, provider, when observed, credits spent, the own-site citation) and the address's latest
 * stored check, plus how many companies still await enrichment and how many have a named person with no address. A read only: it never calls the provider, runs the verifier, records a check,
 * admits, locks or enqueues. Admin only. */
export async function previewPreparedEmailAdmission(ctx:RepositoryContext,input:{limit:number;regions:readonly string[]}):Promise<EmailCampaignPreparedPreview|null>{
 if(!await researchActor(ctx))return null;
 const choices=await listPreparedEmailChoices(ctx,{...input,skip:await admittedCandidateIds(ctx),campaignId:null}),candidates:EmailCampaignPreparedPreview['candidates']=[];
 for(const {read,person} of choices){
  const candidate=(await ctx.db.query<{payload:unknown}>('SELECT payload FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,read.candidateId])).rows[0],payload=candidate&&preparedCandidatePayload(candidate.payload);
  if(!payload)continue;
  const recorded=await latestEmailVerification(ctx,person.email);
  candidates.push({candidateId:read.candidateId,host:read.host,companyName:read.businessName,website:payload.website,locality:read.locality,region:read.region as EmailCampaignPreparedPreview['candidates'][number]['region'],
   person:{firstName:person.firstName,lastName:person.lastName,title:person.title,email:person.email,emailStatus:person.emailStatus==='published'?'published':'verified',matchConfidence:person.matchConfidence,provider:person.provider,observedAt:person.observedAt.toISOString(),creditsSpent:person.credits,source:person.source},
   verification:recorded&&{result:recorded.result,outcome:recorded.outcome,checkedAt:recorded.checkedAt.toISOString()}});
 }
 return {candidates,awaitingEnrichment:await countAwaitingEnrichment(ctx,input.regions),namedWithoutEmail:await countNamedWithoutEmail(ctx)};
}
