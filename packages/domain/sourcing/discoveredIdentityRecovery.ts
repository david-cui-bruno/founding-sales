import type {CandidateInput,QualificationFact,SourceObservation} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {withTransaction,type SessionQueryable} from '../db/queryable.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {listApplicableHolds} from '../policy/holds.ts';
import {readResearchSettings} from '../research/settings.ts';
import {databaseNow} from '../policy/clock.ts';
import {supportedBusinessEmail,qualifyEmailCandidate} from '../outreach/selection.ts';
import {correctCandidateName} from './candidateCorrection.ts';
import {requestQualification,QUALIFICATION_POLICY_VERSION,QUALIFICATION_PROMPT_VERSION,type QualificationRunRow} from './qualificationStore.ts';
interface OfficeName {name:string;fact:QualificationFact}
/** A legal company label in one supported office card, not an SEO title or model-written name. */
function officeName(candidate:CandidateInput,facts:readonly QualificationFact[],observations:readonly SourceObservation[],now:string):OfficeName|null {
 const names=new Map<string,OfficeName&{address:string}>();
 const published:QualificationFact[]=[];
 for(const source of observations)for(const block of source.blocks){
  if(/^(?:e-?mail\s*:?\s*)?[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/iu.test(block.text.trim()))published.push({kind:'business_email',value:block.text,observationId:source.id,blockId:block.id});
 }
 // Inspect other published office cards too: a model may omit a conflicting address.
 if(published.length>30)return null;
 for(const source of observations){
  for(const block of source.blocks){
   const name=block.text.trim();
   if(name.length>160||/\b(?:welcome to|we are|our team|work with|please|powered by|web design|website by)\b/iu.test(name)||!/[\p{L}].*\b(?:LLC|L\.L\.C\.|Inc\.?|Ltd\.?)$/iu.test(name)||/[|\n!?]/u.test(name))continue;
   const identity={status:'resolved' as const,name,website:candidate.website,locality:candidate.locality,region:candidate.region};
   const route=supportedBusinessEmail({identity,facts:published,observations,now});
   if(!route||route.identityKind!=='role'||route.sourceObservationId!==source.id)continue;
   names.set(name.normalize('NFKC').toLowerCase(),{name,address:route.address,fact:{kind:'firm_identity',value:block.text,observationId:source.id,blockId:block.id}});
  }
 }
 if(names.size!==1)return null;
 const supported=[...names.values()][0]!;
 const selected=supportedBusinessEmail({identity:{status:'resolved',name:supported.name,website:candidate.website,locality:candidate.locality,region:candidate.region},facts,observations,now});
 return selected?.address===supported.address?supported:null;
}
/** Adds only the literal office-name citation; the original model/source evidence remains. */
export function withSupportedOfficeName(candidate:CandidateInput,facts:readonly QualificationFact[],observations:readonly SourceObservation[],now:string):QualificationFact[] {
 const supported=officeName(candidate,facts,observations,now);
 return supported&&!facts.some(f=>f.kind==='firm_identity'&&f.observationId===supported.fact.observationId&&f.blockId===supported.fact.blockId)?[...facts,supported.fact]:[...facts];
}
/** Owns a transaction. Correct only an untouched discovery candidate; old revisions stay invalid until bounded fresh research succeeds. */
export async function recoverDiscoveredIdentity(ctx:RepositoryContext,runId:string):Promise<void> {
 if(ctx.scope.actor.kind!=='system'||ctx.scope.actor.component!=='worker')return;
 await withTransaction(ctx.db as SessionQueryable,async()=>{
  await lockSendGateForStopFact(ctx);
  if(!(await readResearchSettings(ctx)).enabled||(await listApplicableHolds(ctx,{actionKind:'research'})).length)return;
  const w=ctx.scope.workspaceId;
  const candidate=(await ctx.db.query<{id:string;payload:CandidateInput;revision:number;status:string;qualification_blocked:boolean}>(`SELECT c.* FROM sourcing_candidates c JOIN sourcing_qualification_runs r ON r.workspace_id=c.workspace_id AND r.candidate_id=c.id
   WHERE c.workspace_id=$1 AND r.id=$2 FOR UPDATE OF c`,[w,runId])).rows[0];
  if(!candidate||candidate.revision!==1||candidate.status!=='needs_review'||candidate.qualification_blocked)return;
  if(!(await ctx.db.query('SELECT 1 FROM sourcing_discovery_hits WHERE workspace_id=$1 AND candidate_id=$2 LIMIT 1',[w,candidate.id])).rows.length)return;
  const run=(await ctx.db.query<QualificationRunRow>('SELECT * FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,runId])).rows[0];
  if(!run||run.candidate_revision!==1||run.reason||run.policy_version!==QUALIFICATION_POLICY_VERSION||run.prompt_version!==QUALIFICATION_PROMPT_VERSION||!['review','eligible'].includes(run.state))return;
  const now=await databaseNow(ctx),supported=officeName(candidate.payload,run.facts,run.observations,now);
  if(!supported||candidate.payload.firmName===supported.name)return;
  const verdict=qualifyEmailCandidate({identity:{status:'resolved',name:supported.name,website:candidate.payload.website,locality:candidate.payload.locality,region:candidate.payload.region},facts:run.facts,observations:run.observations,now});
  if(verdict.decision!=='eligible')return;
  const correction=await correctCandidateName(ctx,{id:candidate.id,expectedRevision:1,firmName:supported.name,qualificationRunId:run.id,observationId:supported.fact.observationId,blockId:supported.fact.blockId,reason:'Supported legal company label in one first-party office contact card; replace unverified discovery title.'});
  const next=correction.ok?await requestQualification(ctx,{candidateId:candidate.id,expectedRevision:correction.value.revision}):null;
  if(correction.ok&&!next?.ok)await ctx.db.query('INSERT INTO sourcing_discovery_settings(workspace_id,qualification_wait_reason) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET qualification_wait_reason=$2',[w,next?.reason??'identity_research_deferred']);
 });
}
