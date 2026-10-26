import {randomUUID,createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {PROSPECT_PHONE_DISCOVERY_VERSION,prospectPhoneDiscoveryInputSchema,sourceObservationSchema,type ProspectPhoneDiscoveryInput,type ProspectPhoneDiscoveryView,type ProspectPhoneDiscoveryReason,type SourceObservation} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {withTransaction} from '../db/queryable.ts';
import {enqueueJob} from '../jobs/jobStore.ts';
import {jobIdempotencyKey} from '../jobs/jobKinds.ts';
import {incrementDailyCounter} from '../jobs/counters.ts';
import {RESEARCH_FIRM_RUN_COUNTER} from '../research/ceilings.ts';
import {workspaceBusinessZone} from '../research/ledger.ts';
import {readResearchSettings} from '../research/settings.ts';
import type {PageFetchProvider,PageFetchResult} from '../research/providers.ts';
import {parsePageText} from '../research/pageText.ts';
import {isPublicResearchUrl,isSameResearchSite} from '../research/sourcePolicy.ts';
import {retainedCandidateOnly} from './retainedAcquisition.ts';
import {phoneDiscoveryContext,phoneDiscoveryNow,phoneDiscoveryPrincipal,phoneDiscoveryResearchRefusal,phoneDiscoverySourceLimit,type PhoneDiscoveryAuthority} from './prospectPhoneDiscoveryAuthority.ts';
import {invalidatePhoneDiscovery,lockPhoneDiscoveryCandidate,lockPhoneDiscoveryRun,phoneDiscoveryRun,validatePhoneDiscoveryRun} from './prospectPhoneDiscoveryStore.ts';
import {prospectPhoneDiscoveryView} from './prospectPhoneDiscoveryProjection.ts';
import {sweepProspectPhoneDiscoveries} from './prospectPhoneDiscoveryLifecycle.ts';

export class ProspectPhoneDiscoveryAuthorityChanged extends Error {constructor(){super('phone_discovery_authority_changed');this.name='ProspectPhoneDiscoveryAuthorityChanged';}}
export class ProspectPhoneDiscoveryUnavailable extends Error {constructor(readonly reason:string){super(reason);this.name='ProspectPhoneDiscoveryUnavailable';}}
/** Command adapter invokes after receipt/audit waits and before transaction commit. */
export async function currentProspectPhoneDiscoveryAuthority(ctx:RepositoryContext,input:ProspectPhoneDiscoveryInput,runId:string,authority:PhoneDiscoveryAuthority=async()=>true):Promise<void>{
 if(!await phoneDiscoveryPrincipal(ctx,authority))throw new ProspectPhoneDiscoveryAuthorityChanged();
 const candidate=await lockPhoneDiscoveryCandidate(ctx,input.candidateId);
 if(!candidate||candidate.revision!==input.expectedRevision)throw new ProspectPhoneDiscoveryUnavailable(candidate?'candidate_changed':'candidate_unavailable');
 const run=await phoneDiscoveryRun(ctx,input.candidateId,input.expectedRevision);
 if(!run||run.id!==runId)throw new ProspectPhoneDiscoveryUnavailable('source_changed');
 if(run.state!=='unavailable'){
  const denial=await validatePhoneDiscoveryRun(ctx,run,true);
  if(denial)throw new ProspectPhoneDiscoveryUnavailable(denial);
 }else if(!await phoneDiscoveryContext(ctx,input.candidateId,input.expectedRevision))throw new ProspectPhoneDiscoveryUnavailable('source_unavailable');
 if(!await phoneDiscoveryPrincipal(ctx,authority))throw new ProspectPhoneDiscoveryAuthorityChanged();
 if(run.state!=='unavailable'){const denial=await validatePhoneDiscoveryRun(ctx,run,true);if(denial)throw new ProspectPhoneDiscoveryUnavailable(denial);}
}
/** Existing finite scheduler owns this transaction. No acquire/reclaim path. */
export async function expireProspectPhoneDiscoveryInTransaction(ctx:RepositoryContext):Promise<number>{return sweepProspectPhoneDiscoveries(ctx,{limit:100});}

type Result<T>={ok:true;value:T}|{ok:false;reason:string};
const refuse=(reason:string):{ok:false;reason:string}=>({ok:false,reason});
/** Caller owns command transaction. The job is not visible until request commit. */
export async function requestProspectPhoneDiscovery(ctx:RepositoryContext,input:ProspectPhoneDiscoveryInput,authority:PhoneDiscoveryAuthority=async()=>true):Promise<Result<{runId:string}>>{
 if(ctx.scope.actor.kind!=='user'||ctx.scope.actor.role!=='admin')return refuse('admin_only');
 if(!prospectPhoneDiscoveryInputSchema.safeParse(input).success)return refuse('invalid_input');
 const candidate=await lockPhoneDiscoveryCandidate(ctx,input.candidateId);
 if(!candidate)return refuse('candidate_unavailable');
 if(candidate.revision!==input.expectedRevision)return refuse('candidate_changed');
 if(!await phoneDiscoveryPrincipal(ctx,authority))return refuse('authority_changed');
 const previous=await phoneDiscoveryRun(ctx,input.candidateId,input.expectedRevision);
 if(previous){
  if(previous.state!=='unavailable'){
   const denial=await validatePhoneDiscoveryRun(ctx,previous,false);
   if(denial)await invalidatePhoneDiscovery(ctx,previous.id,denial);
  }
  if(!await phoneDiscoveryPrincipal(ctx,authority))return refuse('authority_changed');
  return {ok:true,value:{runId:previous.id}};
 }
 if(await retainedCandidateOnly(ctx,input.candidateId))return refuse('retained_only');
 const context=await phoneDiscoveryContext(ctx,input.candidateId,input.expectedRevision);
 if(!context)return refuse('official_site_unknown');
 const research=await phoneDiscoveryResearchRefusal(ctx,ctx.scope.actor.userId);if(research)return refuse(research);
 const limits=await phoneDiscoverySourceLimit(ctx,[context.website,...context.sourceUrls]);
 if(limits.denied)return refuse('source_not_permitted');
 const now=await phoneDiscoveryNow(ctx),settings=await readResearchSettings(ctx);
 const count=await incrementDailyCounter(ctx,{subjectKind:'workspace',subjectKey:ctx.scope.workspaceId,counterKind:RESEARCH_FIRM_RUN_COUNTER,
  businessTimeZone:await workspaceBusinessZone(ctx),at:now.toISOString()},settings.dailyFirmCeiling);
 if(!count.allowed)return refuse('daily_firm_ceiling');
 // Counter/settings/principal waits cannot preserve an earlier source grant.
 if(!await phoneDiscoveryPrincipal(ctx,authority))return refuse('authority_changed');
 if(!isDeepStrictEqual(context,await phoneDiscoveryContext(ctx,input.candidateId,input.expectedRevision)))return refuse('source_changed');
 const finalResearch=await phoneDiscoveryResearchRefusal(ctx,ctx.scope.actor.userId);if(finalResearch)return refuse(finalResearch);
 const finalLimits=await phoneDiscoverySourceLimit(ctx,[context.website,...context.sourceUrls]),at=await phoneDiscoveryNow(ctx);
 if(finalLimits.denied)return refuse('source_not_permitted');
 const expiresAt=new Date(Math.min(at.getTime()+7*86400000,finalLimits.expiresAt?.getTime()??Infinity));
 if(expiresAt<=at)return refuse('source_expired');
 const runId=randomUUID();
 await ctx.db.query(`INSERT INTO sourcing_prospect_phone_discoveries(workspace_id,id,candidate_id,candidate_revision,creator_user_id,creator_ref,method,requested_at,deadline_at,expires_at,content)
 VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10::jsonb)`,[ctx.scope.workspaceId,runId,input.candidateId,input.expectedRevision,ctx.scope.actor.userId,PROSPECT_PHONE_DISCOVERY_VERSION,
  at.toISOString(),new Date(at.getTime()+30*60000).toISOString(),expiresAt.toISOString(),JSON.stringify({...context,observations:[]})]);
 await enqueueJob(ctx.db,{workspaceId:ctx.scope.workspaceId,kind:'sourcing.phone_discover',idempotencyKey:jobIdempotencyKey.sourcingPhoneDiscover(runId),payload:{runId},maxAttempts:1});
 // Receipt/job uniqueness can wait. Recheck source and principal before acceptance.
 if(!await phoneDiscoveryPrincipal(ctx,authority))throw new ProspectPhoneDiscoveryAuthorityChanged();
 const saved=await phoneDiscoveryRun(ctx,input.candidateId,input.expectedRevision);
 if(!saved)throw new Error('phone_discovery_run_missing');
 const denial=await validatePhoneDiscoveryRun(ctx,saved,true);
 if(denial)await invalidatePhoneDiscovery(ctx,runId,denial);
 return {ok:true,value:{runId}};
}
/** Caller owns read transaction. Never enqueues, refreshes or fetches. */
export async function readProspectPhoneDiscovery(ctx:RepositoryContext,input:ProspectPhoneDiscoveryInput,authority:PhoneDiscoveryAuthority=async()=>true):Promise<Result<ProspectPhoneDiscoveryView|null>>{
 if(ctx.scope.actor.kind!=='user'||ctx.scope.actor.role!=='admin')return refuse('admin_only');
 if(!prospectPhoneDiscoveryInputSchema.safeParse(input).success)return refuse('invalid_input');
 const candidate=await lockPhoneDiscoveryCandidate(ctx,input.candidateId);
 if(!candidate)return refuse('candidate_unavailable');
 if(candidate.revision!==input.expectedRevision)return refuse('candidate_changed');
 const run=await phoneDiscoveryRun(ctx,input.candidateId,input.expectedRevision);
 if(!await phoneDiscoveryPrincipal(ctx,authority))return refuse('authority_changed');
 if(!run)return {ok:true,value:null};
 if(run.state!=='unavailable'){
  const denial=await validatePhoneDiscoveryRun(ctx,run,false);
  if(denial)await invalidatePhoneDiscovery(ctx,run.id,denial);
 }
 if(!await phoneDiscoveryPrincipal(ctx,authority))return refuse('authority_changed');
 const current=await phoneDiscoveryRun(ctx,input.candidateId,input.expectedRevision);
 if(!current)return {ok:true,value:null};
 if(current.state!=='unavailable'){
  const denial=await validatePhoneDiscoveryRun(ctx,current,false);
  if(denial){await invalidatePhoneDiscovery(ctx,current.id,denial);current.state='unavailable';current.reason=denial;current.content=null;current.checked_at=await phoneDiscoveryNow(ctx);}
 }
 return {ok:true,value:prospectPhoneDiscoveryView(current,(await phoneDiscoveryNow(ctx)).getTime())};
}
/** Validates a whole capture. No selected prefix survives incomplete pages/bounds. */
export function captureProspectPhonePages(pages:PageFetchResult['pages'],website:string,maxPages:number,maxBytes:number,now:number):Result<SourceObservation[]>{
 if(pages.length===0)return refuse('source_unavailable');
 if(pages.length>maxPages||pages.length>4)return refuse('bounded_capture_incomplete');
 const observations:SourceObservation[]=[];
 for(const page of pages){
  if(!page.firstParty||!isPublicResearchUrl(page.url)||!isSameResearchSite(website,page.url))return refuse('source_not_permitted');
  if(page.body.byteLength>maxBytes)return refuse('bounded_capture_incomplete');
  const parsed=parsePageText(page.body,page.contentType,{omitNavigation:true,includeArticles:true});
  if(parsed.truncated||parsed.blocks.some(block=>block.text.length>4000))return refuse('bounded_capture_incomplete');
  if(!parsed.blocks.length)return refuse('no_readable_text');
  const blocks=parsed.blocks.map(block=>({...block}));
  const source=sourceObservationSchema.safeParse({id:randomUUID(),url:page.url,contentHash:page.contentHash,relevantTextHash:createHash('sha256').update(JSON.stringify(blocks)).digest('hex'),
   retrievedAt:page.retrievedAt,publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks});
  if(!source.success||Date.parse(source.data.retrievedAt)>now)return refuse('source_unavailable');
  observations.push(source.data);
 }
 if(new Set(observations.map(source=>source.url)).size!==observations.length||Buffer.byteLength(JSON.stringify(observations))>100000)return refuse('bounded_capture_incomplete');
 return {ok:true,value:observations};
}
/** Owns committed claim/network/finalization phases. A running run is never reclaimed. */
export async function runProspectPhoneDiscovery(ctx:RepositoryContext,input:{runId:string},deps:{pageFetch:PageFetchProvider}):Promise<void>{
 const initial=await withTransaction(ctx.db,async()=>{
  const run=await lockPhoneDiscoveryRun(ctx,input.runId);
  if(!run||run.state!=='pending')return null;
  const denial=await validatePhoneDiscoveryRun(ctx,run,true);
  if(denial){await invalidatePhoneDiscovery(ctx,run.id,denial);return null;}
  await ctx.db.query("UPDATE sourcing_prospect_phone_discoveries SET state='running',dispatched_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND state='pending'",[ctx.scope.workspaceId,run.id]);
  return run;
 });
 if(!initial?.content)return;
 let interruption:ProspectPhoneDiscoveryReason|null=null;
 const settings=await readResearchSettings(ctx),maxPages=Math.min(settings.maxPagesPerFirm,4),maxBytes=Math.min(settings.maxPageBytes,1000000);
 const allowed=()=>withTransaction(ctx.db,async()=>{
  const run=await lockPhoneDiscoveryRun(ctx,initial.id);
  if(!run||run.state!=='running'){interruption='discovery_interrupted';return false;}
  interruption=await validatePhoneDiscoveryRun(ctx,run,true);
  const liveSettings=await readResearchSettings(ctx);
  if(!interruption&&(Math.min(liveSettings.maxPagesPerFirm,4)<maxPages||Math.min(liveSettings.maxPageBytes,1000000)<maxBytes))interruption='bounded_capture_incomplete';
  if(interruption){await invalidatePhoneDiscovery(ctx,run.id,interruption);return false;}
  return true;
 });
 let captured:Result<SourceObservation[]>;
 try{
  if(!await allowed())captured=refuse(interruption??'discovery_interrupted');
  else{
   const {website,sourceUrls}=initial.content;
   const urls=[...new Set([website,...sourceUrls.filter(url=>isPublicResearchUrl(url)&&isSameResearchSite(website,url))])];
   const answer=await deps.pageFetch.fetchPages({urls,firmWebsite:website,links:urls,prioritizeContactPages:true,maxPagesPerFirm:maxPages,maxBytes,shouldContinue:allowed});
   // The real provider omits an aborted over-byte-cap page. Its surviving
   // prefix cannot establish complete phone coverage. Intentional page-budget
   // limits and policy refusals are not evidence of an over-bound original.
   captured=!answer.ok?refuse('source_unavailable'):(answer.value.skipped['page_over_bound']??0)>0?refuse('bounded_capture_incomplete'):
    captureProspectPhonePages(answer.value.pages,website,maxPages,maxBytes,(await phoneDiscoveryNow(ctx)).getTime());
  }
 }catch{captured=refuse('source_unavailable');}
 await withTransaction(ctx.db,async()=>{
  const run=await lockPhoneDiscoveryRun(ctx,initial.id);
  if(!run)return;
  if(run.state!=='running'){
   // Record dispatch completion without resurrecting content erased during IO.
   if(run.dispatched_at&&!run.dispatch_finished_at)await ctx.db.query('UPDATE sourcing_prospect_phone_discoveries SET dispatch_finished_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,run.id]);
   return;
  }
  const denial=await validatePhoneDiscoveryRun(ctx,run,true);
  if(denial||interruption||!captured.ok){await invalidatePhoneDiscovery(ctx,run.id,denial??interruption??(!captured.ok?captured.reason as ProspectPhoneDiscoveryReason:'discovery_interrupted'),true);return;}
  const currentSettings=await readResearchSettings(ctx);
  if(captured.value.length>Math.min(currentSettings.maxPagesPerFirm,4)||Math.min(currentSettings.maxPageBytes,1000000)<maxBytes||captured.value.some(source=>Date.parse(source.retrievedAt)<run.requested_at.getTime())){
   await invalidatePhoneDiscovery(ctx,run.id,'bounded_capture_incomplete',true);return;
  }
  // Newly fetched pages have their own exact URL/hash/time and shorter-source fence.
  const sourceLimit=await phoneDiscoverySourceLimit(ctx,captured.value.map(source=>source.url));
  const expiresAt=new Date(Math.min(run.expires_at.getTime(),sourceLimit.expiresAt?.getTime()??Infinity));
  if(sourceLimit.denied||expiresAt<=(await phoneDiscoveryNow(ctx))){await invalidatePhoneDiscovery(ctx,run.id,'source_not_permitted',true);return;}
  const content=JSON.stringify({...run.content,observations:captured.value});
  const bounded=await ctx.db.query<{valid:boolean}>('SELECT prospect_phone_content_valid($1::jsonb) AS valid',[content]);
  if(!bounded.rows[0]?.valid){await invalidatePhoneDiscovery(ctx,run.id,'bounded_capture_incomplete',true);return;}
  await ctx.db.query(`UPDATE sourcing_prospect_phone_discoveries SET state='complete',checked_at=clock_timestamp(),dispatch_finished_at=clock_timestamp(),expires_at=$3,
   content=$4::jsonb WHERE workspace_id=$1 AND id=$2 AND state='running'`,[ctx.scope.workspaceId,run.id,expiresAt.toISOString(),content]);
 });
}
