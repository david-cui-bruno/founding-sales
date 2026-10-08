import {withSupportedOfficeName,recoverDiscoveredIdentity} from './discoveredIdentityRecovery.ts';
import {createHash,randomUUID} from 'node:crypto';
import type {CandidateInput,SourceObservation,QualificationFact} from '@fss/contracts';
import {withTransaction,type SessionQueryable} from '../db/queryable.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {decideAdminOnly} from '../crm/authorization.ts';
import {databaseNow} from '../policy/clock.ts';
import {listApplicableHolds} from '../policy/holds.ts';
import {readResearchSettings} from '../research/settings.ts';
import {lockResearchBudget} from '../research/ceilings.ts';
import {readCreditSpend,workspaceBusinessZone} from '../research/ledger.ts';
import {reserveAttempt,markCalling,settleAttempt} from '../research/reservations.ts';
import {centsOf,isPricedModel} from '../research/pricing.ts';
import {parsePageText} from '../research/pageText.ts';
import {isPublicResearchUrl,withoutFragment} from '../research/sourcePolicy.ts';
import type {PageFetchProvider,ProviderOutcome} from '../research/providers.ts';
import {finishQualification,QUALIFICATION_PROMPT_VERSION,QUALIFICATION_POLICY_VERSION,type QualificationRunRow} from './qualificationStore.ts';
import {QUALIFICATION_OUTPUT_TOKENS,type QualificationExtractionProvider,type QualificationExtractionAnswer} from './qualificationPrompt.ts';
interface Run extends QualificationRunRow {payload:CandidateInput;current_revision:number;candidate_status:string}
const readSql=`SELECT r.*,c.payload,c.revision AS current_revision,c.status AS candidate_status FROM sourcing_qualification_runs r
 JOIN sourcing_candidates c ON c.workspace_id=r.workspace_id AND c.id=r.candidate_id WHERE r.workspace_id=$1 AND r.id=$2`;
async function allowed(ctx:RepositoryContext,runId:string):Promise<Run|null>{
 const row=(await ctx.db.query<Run>(readSql,[ctx.scope.workspaceId,runId])).rows[0];
 if(!row||!['pending','running'].includes(row.state)||row.candidate_status==='dismissed'||row.current_revision!==row.candidate_revision||row.deadline_at.getTime()<=Date.parse(await databaseNow(ctx)))return null;
 if(!(await readResearchSettings(ctx)).enabled||(await listApplicableHolds(ctx,{actionKind:'research'})).length)return null;
 return row;
}
/** Owns its committed stages. The outbound-fence handler must not wrap this in a transaction. */
export async function runQualification(ctx:RepositoryContext,input:{runId:string},deps:{pageFetch:PageFetchProvider;extraction:QualificationExtractionProvider|null}):Promise<void>{
 if(!decideAdminOnly(ctx).permitted)return;
 const db=ctx.db as SessionQueryable;
 const run=await withTransaction(db,async()=>{
  const row=await allowed(ctx,input.runId);if(!row)return null;
  const changed=await db.query("UPDATE sourcing_qualification_runs SET state='running' WHERE workspace_id=$1 AND id=$2 AND state='pending' RETURNING id",[ctx.scope.workspaceId,row.id]);
  return changed.rows.length?row:null;
 });
 if(!run)return;
 let observations:SourceObservation[]=[];
 const finish=async(reason:string|null,facts:unknown[]=[],openingQuestion:string|null=null,supplementedEvidence:readonly Pick<QualificationFact,'kind'|'observationId'|'blockId'>[]=[])=>withTransaction(db,()=>finishQualification(ctx,{runId:run.id,observations,facts,reason,openingQuestion,supplementedEvidence}));
 if(run.prompt_version!==QUALIFICATION_PROMPT_VERSION||run.policy_version!==QUALIFICATION_POLICY_VERSION){await finish('qualification_version_changed');return;}
 const extraction=deps.extraction;
 if(!extraction||extraction.providerKey!=='aws_bedrock.sourcing_qualification'||!isPricedModel(run.model_name,'bedrock')){await finish('credit_route_unavailable');return;}
 const website=run.payload.website,source=withoutFragment(run.payload.sourceUrl);
 if(!website||!isPublicResearchUrl(website)||!isPublicResearchUrl(source)){await finish('official_site_unknown');return;}
 // A search hit on another host is not authority to read that host as this business.
 const host=(url:string)=>new URL(url).hostname.toLowerCase().replace(/^www\./u,'');
 if(host(source)!==host(website)){await finish('official_site_unknown');return;}
 const settings=await readResearchSettings(ctx);
 try{
  const fetched=await deps.pageFetch.fetchPages({urls:[...new Set([source,withoutFragment(website)])],firmWebsite:website,links:[source],prioritizeContactPages:true,maxPagesPerFirm:settings.maxPagesPerFirm,maxBytes:settings.maxPageBytes,shouldContinue:async()=>await allowed(ctx,run.id)!==null});
  if(!fetched.ok){await finish('source_unavailable');return;}
  observations=fetched.value.pages.slice(0,settings.maxPagesPerFirm).flatMap(page=>{
   const parsed=parsePageText(page.body,page.contentType,{omitNavigation:true,includeArticles:true});
   const blocks=parsed.blocks.filter(b=>b.text.length<=2000).slice(0,100);
   if(!blocks.length)return [];
   const publication=blocks.flatMap(block=>{
    const match=/\b(?:published|posted)(?:\s+on)?\s*:?\s*(\d{4}-\d{2}-\d{2})\b/iu.exec(block.text);
    if(!match)return [];
    const value=`${match[1]}T00:00:00.000Z`,time=Date.parse(value);
    return Number.isFinite(time)&&new Date(time).toISOString()===value&&time<=Date.parse(page.retrievedAt)?[{value,blockId:block.id}]:[];
   });
   const date=publication.length===1?publication[0]:undefined;
   return [{id:randomUUID(),url:page.url,contentHash:page.contentHash,relevantTextHash:createHash('sha256').update(JSON.stringify(blocks)).digest('hex'),
    retrievedAt:page.retrievedAt,publishedAt:date?.value??null,publishedAtBlockId:date?.blockId??null,firstParty:page.firstParty,blocks,truncated:parsed.truncated||blocks.length<parsed.blocks.length}];
  });
 }catch{await finish('source_unavailable');return;}
 if(!observations.length||Buffer.byteLength(JSON.stringify(observations))>100000){observations=[];await finish('source_unavailable');return;}
 if(!await allowed(ctx,run.id)){await finish('research_interrupted');return;}
 await db.query(`UPDATE sourcing_qualification_runs SET observations=$3::jsonb WHERE workspace_id=$1 AND id=$2 AND state='running'
  AND EXISTS(SELECT 1 FROM sourcing_candidates c WHERE c.workspace_id=$1 AND c.id=candidate_id AND c.revision=candidate_revision AND c.status<>'dismissed')`,[ctx.scope.workspaceId,run.id,JSON.stringify(observations)]);
 // Interpretations may be reused only for the same identity/revision and model/policy/prompt.
 const previous=(await db.query<QualificationRunRow>(`SELECT * FROM sourcing_qualification_runs WHERE workspace_id=$1 AND candidate_id=$2 AND id<>$3
  AND candidate_revision=$4 AND prompt_version=$5 AND policy_version=$6 AND model_name=$7 AND state IN ('review','eligible','admitted') AND reason IS NULL
  ORDER BY requested_at DESC,id DESC LIMIT 1`,[ctx.scope.workspaceId,run.candidate_id,run.id,run.candidate_revision,run.prompt_version,run.policy_version,run.model_name])).rows[0];
 if(previous && previous.facts.every(f=>previous.observations.some(s=>s.id===f.observationId&&s.firstParty&&!s.truncated)) && previous.observations.length===observations.length && observations.every(source=>previous.observations.some(old=>old.url===source.url&&old.relevantTextHash===source.relevantTextHash&&old.firstParty===source.firstParty&&old.truncated===source.truncated))){
  const oldToNew=new Map(previous.observations.map(old=>[old.id,observations.find(source=>source.url===old.url)!.id]));
  observations=observations.map(source=>{const old=previous.observations.find(item=>item.url===source.url)!;return {...source,publishedAt:old.publishedAt,publishedAtBlockId:old.publishedAtBlockId};});
  const facts=previous.facts.map(fact=>({...fact,observationId:oldToNew.get(fact.observationId)!}));
  const supplemented=withSupportedOfficeName(run.payload,facts,observations,await databaseNow(ctx));
  const citations=supplemented.filter(f=>!facts.some(original=>original.kind===f.kind&&original.observationId===f.observationId&&original.blockId===f.blockId)).map(({kind,observationId,blockId})=>({kind,observationId,blockId}));
  const saved=await finish(null,supplemented,previous.opening_question,citations);
  if(saved.ok)await recoverDiscoveredIdentity(ctx,run.id);return;
 }
 const offered=observations.filter(source=>source.firstParty&&!source.truncated);
 if(!offered.length){await finish('source_incomplete_or_unverified');return;}
 const request={observations:offered,modelName:run.model_name,maxInputTokens:0,maxOutputTokens:QUALIFICATION_OUTPUT_TOKENS};
 let tokens:number;
 try{tokens=await extraction.countInputTokens(request);}catch{await finish('token_count_unavailable');return;}
 if(!Number.isSafeInteger(tokens)||tokens<1||tokens>100000){await finish('input_over_budget');return;}
 request.maxInputTokens=tokens;
 const cents=centsOf(run.model_name,{inputTokens:tokens,outputTokens:QUALIFICATION_OUTPUT_TOKENS},'bedrock');
 const reservation=await withTransaction(db,async()=>{
  await lockResearchBudget(ctx);
  if(!await allowed(ctx,run.id))return null;
  const current=await readResearchSettings(ctx),at=await databaseNow(ctx),zone=await workspaceBusinessZone(ctx);
  const spend=await readCreditSpend(ctx,{at,businessTimeZone:zone});
  if(spend.todayCents+cents>current.dailyCostCeilingCents||spend.monthToDateCents+cents>current.monthlyCostCeilingCents)return null;
  const held=await reserveAttempt(ctx,{subjectKind:'sourcing_qualification',subjectId:run.id,attempt:1,providerKey:extraction.providerKey,at,businessTimeZone:zone,cents,modelName:run.model_name,maxInputTokens:tokens,maxOutputTokens:QUALIFICATION_OUTPUT_TOKENS});
  if(!await markCalling(ctx,held.id))return null;
  return held;
 });
 if(!reservation){await finish('research_budget_or_hold');return;}
 if(!await allowed(ctx,run.id)){
  await withTransaction(db,async()=>settleAttempt(ctx,{reservationId:reservation.id,at:await databaseNow(ctx),outcome:{kind:'released_not_called'}}));
  await finish('research_interrupted');return;
 }
 let result:ProviderOutcome<QualificationExtractionAnswer>;
 try{result=await extraction.extract(request);}catch{result={ok:false,failureCode:'provider_error',costCents:0,costEstimated:true};}
 await withTransaction(db,async()=>{
  await settleAttempt(ctx,{reservationId:reservation.id,at:await databaseNow(ctx),outcome:result.costEstimated?{kind:'estimated'}:{kind:'settled',cents:result.costCents}});
 });
 // Settlement has its own commit so even invalid/stale evidence cannot erase spent money.
 if(result.ok&&result.value.facts.some(f=>!offered.some(source=>source.id===f.observationId))){await finish('invalid_evidence');return;}
 const facts=result.ok?withSupportedOfficeName(run.payload,result.value.facts,observations,await databaseNow(ctx)):[];
 const supplementedEvidence=result.ok?facts.filter(f=>!result.value.facts.some(original=>original.kind===f.kind&&original.observationId===f.observationId&&original.blockId===f.blockId)).map(({kind,observationId,blockId})=>({kind,observationId,blockId})):[];
 const saved=await finish(result.ok?null:result.failureCode,facts,result.ok?result.value.openingQuestion:null,supplementedEvidence);
 if(saved.ok&&result.ok)await recoverDiscoveredIdentity(ctx,run.id);
 if(!saved.ok&&saved.reason==='invalid_evidence'){observations=[];await finish('invalid_evidence');}
}
/** Scheduler sweep is independent of whether any qualification handler manages to start. */
export async function expireQualifications(ctx:RepositoryContext):Promise<void>{
 if(!decideAdminOnly(ctx).permitted)return;
 await withTransaction(ctx.db as SessionQueryable,()=>expireQualificationsInTransaction(ctx));
}
export async function expireQualificationsInTransaction(ctx:RepositoryContext):Promise<void>{
 if(!decideAdminOnly(ctx).permitted)return;
  // A correction/deletion can retire the run while its paid call is still outstanding.
  // Account for those calls by reservation age/deadline, independently of run state.
  const reservations=(await ctx.db.query<{id:string;state:string}>(`SELECT p.id,p.state FROM provider_reservations p
   LEFT JOIN sourcing_qualification_runs r ON r.workspace_id=p.workspace_id AND r.id=p.subject_id
   WHERE p.workspace_id=$1 AND p.subject_kind='sourcing_qualification' AND p.state IN ('reserved','calling')
    AND (p.created_at<=now()-interval '30 minutes' OR r.deadline_at<=now()) ORDER BY p.created_at,p.id LIMIT 100`,[ctx.scope.workspaceId])).rows;
  for(const row of reservations)await settleAttempt(ctx,{reservationId:row.id,at:await databaseNow(ctx),outcome:{kind:row.state==='calling'?'estimated':'released'}});
  await ctx.db.query(`UPDATE sourcing_qualification_runs SET state='unavailable',reason='qualification_expired',finished_at=now()
   WHERE workspace_id=$1 AND id IN (SELECT id FROM sourcing_qualification_runs WHERE workspace_id=$1 AND state IN ('pending','running') AND deadline_at<=now() ORDER BY deadline_at LIMIT 50)`,[ctx.scope.workspaceId]);
}
