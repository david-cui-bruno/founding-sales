import type {FinishResearchInput,ResearchRunReport} from './enrichment.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {databaseNow} from '../policy/clock.ts';
import {officeNow,readOfficeAssessmentBinding} from './officeAssessmentTarget.ts';
import {finishOfficeAssessment,markOfficeUnavailable,retainedOfficeSources} from './officeAssessmentStore.ts';
import {buildOfficeObservations,currentOfficeSources,reconstructOfficeSelections} from './officeAssessmentEvidence.ts';
import {OFFICE_SELECTION_VERSION,type OfficeExtractionRequest} from './officeAssessmentContract.ts';
import {readResearchSettings} from './settings.ts';
import {researchUrlsForFirm} from './sourcePolicy.ts';
import {finaliseSubjectReservations,readAttempt,settleAttempt} from './reservations.ts';
import {researchRunCost} from './eligibility.ts';
import {completeRun,lockRun} from './runs.ts';
import {recordEvidence} from '../crm/evidence.ts';
import {recordProviderCall,workspaceBusinessZone} from './ledger.ts';
import {admitCall} from './pricing.ts';
import {transportOfProviderKey} from '../classification/modelTransport.ts';
import {accept,refuse,type ResearchResult} from './types.ts';
import type {ProviderOutcome} from './providers.ts';
async function attempt<T>(call:()=>Promise<ProviderOutcome<T>>):Promise<ProviderOutcome<T>>{try{return await call();}catch{return {ok:false,failureCode:'transport_error',costCents:0,costEstimated:true};}}
/** Existing run and one reservation only. No ordinary facts/judgments or refresh writes. */
export async function finishOfficeResearch(ctx:RepositoryContext,input:FinishResearchInput):Promise<ResearchResult<ResearchRunReport>>{
 const reservation=await readAttempt(ctx,{subjectKind:'research_run',subjectId:input.runId,attempt:input.attempt});
 let pagesFetched=0,evidenceRecorded=0,called=false,used=false,inputTokens=0,outputTokens=0;
 const deferred:Array<()=>Promise<void>>=[];
 const done=async(reason:string|null):Promise<ResearchResult<ResearchRunReport>>=>{
  if(reason)await markOfficeUnavailable(ctx,input.runId,reason);
  if(!called&&reservation)await settleAttempt(ctx,{reservationId:reservation.id,at:await databaseNow(ctx),outcome:{kind:'released_not_called'}});
  await finaliseSubjectReservations(ctx,{subjectKind:'research_run',subjectId:input.runId,at:await databaseNow(ctx)});
  for(const write of deferred)await write();
  const cost=await researchRunCost(ctx,input.runId);
  await completeRun(ctx,{runId:input.runId,at:await databaseNow(ctx),pagesFetched,factsRecorded:0,extraction:used?'used':reason==='input_over_budget'?'over_budget':'failed',costCents:cost.cents,costEstimated:cost.estimated,inputTokens,outputTokens,modelName:used?reservation?.modelName:null});
  return accept({purpose:'office_evidence',runId:input.runId,firmId:input.firmId,revision:input.revision,outcome:'completed',pagesFetched,evidenceRecorded,factsRecorded:0,factsRefused:0,costCents:cost.cents,callFirst:false,callFirstBecameTrue:false,skipped:reason?{[reason]:1}:{}});
 };
 const allowed=async()=>{const run=await lockRun(ctx,input.runId);if(!run||run.purpose!=='office_evidence'||run.outcome!=='running'||run.firmId!==input.firmId||run.revision!==input.revision)return {reason:'run_mismatch'};return await readOfficeAssessmentBinding(ctx,input.runId,true);};
 const initial=await allowed();if('reason' in initial)return initial.reason==='run_mismatch'?refuse('invalid_input'):await done(initial.reason);
 const settings=await readResearchSettings(ctx),zone=await workspaceBusinessZone(ctx);
 const maxPagesPerFirm=Math.min(4,settings.maxPagesPerFirm);
 const links=(await ctx.db.query<{url:string}>(`SELECT url FROM firm_links WHERE workspace_id=$1 AND firm_id=$2 ORDER BY added_at,id`,[ctx.scope.workspaceId,input.firmId])).rows.map(r=>r.url);
 const urls=researchUrlsForFirm({firmWebsite:initial.candidate.website,links,maxPagesPerFirm});
 if(!urls.length)return await done('no_sources');
 const fetched=await attempt(()=>input.pageFetch.fetchPages({urls,firmWebsite:initial.candidate.website,links,maxPagesPerFirm,maxBytes:settings.maxPageBytes,prioritizeContactPages:true,shouldContinue:async()=>!('reason' in await allowed())}));
 deferred.push(()=>recordProviderCall(ctx,{providerKey:input.pageFetch.providerKey,at:input.at,businessTimeZone:zone,costCents:fetched.costCents,...(fetched.ok?{}:{failureCode:fetched.failureCode})}));
 if(!fetched.ok)return await done('source_unavailable');
 pagesFetched=fetched.value.pages.length;
 // The adapter leaves unrequested queue tails at the cap. Actual fetch refusals remain fatal.
 if(pagesFetched>maxPagesPerFirm||Object.entries(fetched.value.skipped).some(([reason,n])=>reason!=='page_budget_reached'&&n>0))return await done('source_incomplete');
 const observations=buildOfficeObservations(fetched.value.pages);
 if(!observations||!currentOfficeSources(initial.candidate,observations,await officeNow(ctx)))return await done('source_incomplete');
 if('reason' in await allowed())return await done('binding_changed');
 const evidenceIds:string[]=[];
 for(const source of observations){const evidence=await recordEvidence(ctx,{firmId:input.firmId,provider:'company_page',sourceReference:source.url,contentHash:source.contentHash,retrievedAt:new Date(source.retrievedAt),detail:{kind:'company_page',blocks:source.blocks.length,truncated:false}});if(!evidence.ok)return await done('source_not_retained');evidenceIds.push(evidence.value.id);evidenceRecorded++;}
 if(!input.extraction||!input.mayCall||!reservation||reservation.state!=='calling'||reservation.providerKey!==input.extraction.providerKey)return await done('extraction_unavailable');
 const extraction=input.extraction;
 const request:OfficeExtractionRequest={purpose:'office_evidence',selectionVersion:OFFICE_SELECTION_VERSION,candidate:initial.candidate,observations,modelName:reservation.modelName,maxOutputTokens:reservation.maxOutputTokens};
 for(const source of observations){for(const block of source.blocks)Object.freeze(block);Object.freeze(source.blocks);Object.freeze(source);}Object.freeze(observations);Object.freeze(request.candidate);Object.freeze(request);
 const retained=()=>retainedOfficeSources(ctx,{firmId:input.firmId,observations,evidenceIds});
 if(!await retained())return await done('source_not_retained');
 if('reason' in await allowed())return await done('binding_changed');
 let tokens:number;try{tokens=await extraction.countInputTokens(request);}catch{return await done('token_count_unavailable');}
 const admission=admitCall({modelName:reservation.modelName,transport:transportOfProviderKey(reservation.providerKey),maxInputTokens:reservation.maxInputTokens,maxOutputTokens:reservation.maxOutputTokens,cents:reservation.cents},tokens);
 if(admission.kind!=='call')return await done('input_over_budget');
 if('reason' in await allowed())return await done('binding_changed');
 if(!await retained())return await done('source_not_retained');
 called=true;
 const answer=await attempt(()=>extraction.extract(request));
 await settleAttempt(ctx,{reservationId:reservation.id,at:await databaseNow(ctx),outcome:answer.costEstimated?{kind:'estimated'}:{kind:'settled',cents:answer.costCents}});
 await recordProviderCall(ctx,{providerKey:extraction.providerKey,at:input.at,businessTimeZone:zone,costCents:0,...(answer.ok?{}:{failureCode:answer.failureCode})});
 if(!answer.ok||answer.value.purpose!=='office_evidence')return await done('extraction_failed');
 inputTokens=answer.value.inputTokens;outputTokens=answer.value.outputTokens;
 if(answer.value.modelName!==reservation.modelName||![inputTokens,outputTokens].every(n=>Number.isSafeInteger(n)&&n>=0)||inputTokens>reservation.maxInputTokens||outputTokens>reservation.maxOutputTokens)return await done('extraction_over_bound');
 const facts=reconstructOfficeSelections(initial.candidate,observations,answer.value.selections);
 if(!facts||!facts.length)return await done('invalid_evidence');
 if(!await finishOfficeAssessment(ctx,{runId:input.runId,observations,facts,evidenceIds}))return await done('publication_stale_or_unretained');
 used=true;return await done(null);
}
