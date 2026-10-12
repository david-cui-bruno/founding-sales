import {askClaimConstructionSchema,constructAskClaim} from '../providers/askAnswerConstruction.ts';
import {admitAskTaskDependencies,readAskTaskDependencyLedger} from '@fss/domain/crm/askTaskDependencies.ts';
import {projectAskOriginalEvidence as modelWindow} from '../providers/askModelEvidence.ts';
import {recordCrmAuditEvent} from '@fss/domain/crm/audit.ts';
import {askDiagnosticToolNameSchema} from '@fss/contracts';
import {crmTokenCostCents} from '@fss/domain/crm/pricing.ts';
import {z} from 'zod';
import {lockAskLifecycle} from '@fss/domain/crm/askAnswerLifecycle.ts';
import {askGroundedAnswerSchema} from '@fss/contracts';
import type {JobHandler,JobHandlerInput} from '@fss/domain/jobs/handlerRegistry.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {repositoryContext,workspaceScope,type RepositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {readCurrentAskInput} from '@fss/domain/crm/askAnswerInput.ts';
import {verifyAskPurpose,readAskPurpose,askFingerprint} from '@fss/domain/crm/askAnswerAuthority.ts';
import type {AskAnswerComposition,AskAnswerAdapter,AskPurposeSnapshot} from '@fss/domain/crm/askAnswerPorts.ts';
import {reserveAttempt,markCalling,settleAttempt} from '@fss/domain/research/reservations.ts';
import {lockMonthlySpend,workspaceBusinessZone} from '@fss/domain/research/ledger.ts';
import {clearMonthlyCash,monthWithinCeiling} from '@fss/domain/settings/cashCeiling.ts';
import {providerFunding} from '@fss/domain/settings/funding.ts';
import {CRM_SUPPORTED_AGENT_ASK_VERSIONS} from '@fss/domain/crm/capabilityAuthority.ts';
import {searchCanonicalIndex} from '@fss/domain/crm/askCanonicalIndex.ts';
import type {CanonicalSourceReference} from '@fss/contracts';
import {admitAskSources,admitAskRecord} from '@fss/domain/crm/askExecutionEvidence.ts';
import {copiedAskSource,askLexicalConfiguration,askLexicalQuery,browseAskHistory,searchAskHistory,readAskConversationSources,readAskConversationAttribution} from '@fss/domain/crm/askHistoryInvestigation.ts';
import {resolveAskRecords,readAskScopedExact,readAskScopedExactObservation} from '@fss/domain/crm/askInvestigationRecords.ts';
import {localDate} from '@fss/domain/src/rules/localClock.ts';

const candidateSchema=z.strictObject({claims:z.array(z.strictObject({text:z.string().min(1).max(1000),kind:z.enum(['extractive','inferred']),citationWindowIds:z.array(z.uuid()).min(1).max(10)})).max(20),abstained:z.boolean()}).refine(value=>!value.abstained||value.claims.length===0);
async function fenced(input:JobHandlerInput){return (await input.session.query("SELECT id FROM jobs WHERE workspace_id=$1 AND id=$2 AND state='running' AND lease_owner=$3 AND fencing_token=$4::bigint AND lease_expires_at>clock_timestamp() FOR UPDATE",[input.scope.workspaceId,input.job.id,input.job.leaseOwner,input.job.fencingToken])).rows.length===1;}
async function now(context:RepositoryContext){return (await context.db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at.toISOString();}
async function locate(input:JobHandlerInput){
 const parsed=z.strictObject({requestId:z.uuid(),version:z.number().int().positive(),epoch:z.number().int().positive()}).safeParse(input.job.payload);if(!parsed.success)return null;
 const row=(await input.session.query<{owner_user_id:string}>('SELECT owner_user_id FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2',[input.scope.workspaceId,parsed.data.requestId])).rows[0];if(row===undefined)return null;
 const member=(await input.session.query<{role:'admin'|'salesperson'}>("SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active'",[input.scope.workspaceId,row.owner_user_id])).rows[0];if(member===undefined)return null;
 return {context:repositoryContext(workspaceScope(input.scope.workspaceId,{kind:'user',userId:row.owner_user_id,role:member.role}),input.session),...parsed.data};
}
async function setState(context:RepositoryContext,id:string,version:number,epoch:number,state:string,reason:string|null){await context.db.query("UPDATE crm_ask_requests SET state=$5,reason=$6,result=NULL,result_at=NULL,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND version=$3 AND epoch=$4 AND state='pending'",[context.scope.workspaceId,id,version,epoch,state,reason]);}
async function withinBudget(context:RepositoryContext,purpose:AskPurposeSnapshot,providerKey:string,extra:number){
 await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${context.scope.workspaceId}:crm-ask-budget:${purpose.purpose}`]);
 await lockMonthlySpend(context);
 const at=await now(context),zone=await workspaceBusinessZone(context),date=localDate(at,zone);
 const totals=(await context.db.query<{daily:string;monthly:string}>(`SELECT coalesce(sum(CASE WHEN state IN ('reserved','calling') THEN cents ELSE settled_cents END) FILTER(WHERE business_date=$2::date),0)::text daily,coalesce(sum(CASE WHEN state IN ('reserved','calling') THEN cents ELSE settled_cents END) FILTER(WHERE date_trunc('month',business_date)=date_trunc('month',$2::date)),0)::text monthly FROM provider_reservations WHERE workspace_id=$1 AND subject_kind IN ('crm_ask_answer','crm_ask_embedding')`,[context.scope.workspaceId,date])).rows[0]!;
 return Number(totals.daily)+extra<=purpose.dailyCeilingCents&&Number(totals.monthly)+extra<=purpose.monthlyCeilingCents&&(providerFunding(providerKey)==='credits'||(extra===0?await monthWithinCeiling(context,{at,zone}):await clearMonthlyCash(context,{at,zone,cents:extra})));
}
/** Durable dispatch state distinguishes proven not-called reservations from unknown calls. */
async function recoverCalling(input:JobHandlerInput){
 const payload=z.strictObject({requestId:z.uuid(),version:z.number().int().positive(),epoch:z.number().int().positive()}).safeParse(input.job.payload);if(!payload.success)return false;
 const {requestId,version,epoch}=payload.data;
 const context=repositoryContext(input.scope,input.session);
 return withTransaction(input.session,async()=>{await lockAskLifecycle(context);
  await context.db.query('SELECT id FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[input.scope.workspaceId,requestId]);
  if(!await fenced(input))return true;
  const previous=(await context.db.query<{id:string;reservation_id:string;dispatch_state:string;job_id:string;fencing_token:string}>('SELECT id,reservation_id,dispatch_state,job_id,fencing_token FROM crm_ask_financial_receipts WHERE workspace_id=$1 AND request_id=$2 AND request_version=$3 AND request_epoch=$4 AND stage=\'answer\'',[input.scope.workspaceId,requestId,version,epoch])).rows[0];
  if(previous===undefined||previous.dispatch_state!=='reserved'&&previous.dispatch_state!=='calling'&&previous.dispatch_state!=='unknown_acceptance')return false;
  if(previous.dispatch_state==='calling'&&previous.job_id===input.job.id&&previous.fencing_token===input.job.fencingToken)return false;
  await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${context.scope.workspaceId}:crm-ask-budget:answer`]);
  await lockMonthlySpend(context);
  if(previous.dispatch_state==='reserved'){
   await settleAttempt(context,{reservationId:previous.reservation_id,at:await now(context),outcome:{kind:'released'}});
   await context.db.query("UPDATE crm_ask_financial_receipts SET dispatch_state='released' WHERE workspace_id=$1 AND id=$2 AND dispatch_state='reserved'",[input.scope.workspaceId,previous.id]);
   await setState(context,requestId,version,epoch,'unavailable','processing_authority_unavailable');
   return true;
  }
  await settleAttempt(context,{reservationId:previous.reservation_id,at:await now(context),outcome:{kind:'estimated'}});
  await context.db.query("UPDATE crm_ask_financial_receipts SET dispatch_state='unknown_acceptance' WHERE workspace_id=$1 AND id=$2 AND dispatch_state='calling'",[context.scope.workspaceId,previous.id]);
  await setState(context,requestId,version,epoch,'unknown_acceptance','provider_acceptance_unknown');
  return true;
 });
}
/** Durable calling precedes the wait; original copies are reread after every external stage. */
export function askAnswerJobHandler(composition:AskAnswerComposition={}):JobHandler{
 return {kind:'crm.ask_answer',protection:'outbound_fence',maxAttempts:3,leaseSeconds:120,async handle(input){
  if(await recoverAgentReceipts(input))return;
  const agentLocated=await locate(input);
  if(agentLocated!==null){const mode=(await input.session.query<{execution_version:string}>('SELECT execution_version FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2',[input.scope.workspaceId,agentLocated.requestId])).rows[0]?.execution_version;if(mode==='agent_v1'){await handleAskAgent(input,composition,agentLocated);return;}}
  const originalAdapter=composition.answer;
  const originalRun=originalAdapter?.run;
  const adapter=originalAdapter===undefined?undefined:{endpointId:originalAdapter.endpointId,modelVersion:originalAdapter.modelVersion,providerKey:originalAdapter.providerKey,run:originalRun!.bind(Object.freeze({...originalAdapter}))};
  const route=adapter===undefined?undefined:{endpointId:adapter.endpointId,modelVersion:adapter.modelVersion,providerKey:adapter.providerKey};
  const runtime={...composition};
  const unchanged=()=>originalAdapter!==undefined&&composition.answer===originalAdapter&&originalAdapter.endpointId===adapter!.endpointId&&originalAdapter.modelVersion===adapter!.modelVersion&&originalAdapter.providerKey===adapter!.providerKey&&originalAdapter.run===originalRun;
  if(await recoverCalling(input))return;
  const located=await locate(input);if(located===null)return;
  const {context,requestId,version,epoch}=located;
  async function snapshot(){return withTransaction(input.session,async()=>{await lockAskLifecycle(context);const current=await readCurrentAskInput(context,requestId,version,epoch,route!);return current!==null&&await fenced(input)?current:null;});}
  if(adapter===undefined){await withTransaction(input.session,async()=>{await lockAskLifecycle(context);if(await fenced(input))await setState(context,requestId,version,epoch,'unavailable','processing_authority_unavailable');});return;}
  const initial=await snapshot();if(initial===null)return;
  const proof=await verifyAskPurpose(runtime,initial.proofInput);
  if(adapter===undefined||proof===null||runtime.retrieval!==undefined||runtime.support!==undefined||adapter.endpointId!==initial.proofInput.purpose.endpointId||adapter.modelVersion!==initial.proofInput.purpose.modelVersion){await withTransaction(input.session,async()=>{await lockAskLifecycle(context);if(await fenced(input))await setState(context,requestId,version,epoch,'unavailable','processing_authority_unavailable');});return;}
  if(initial.inputBoundReached){await withTransaction(input.session,async()=>{await lockAskLifecycle(context);if(await fenced(input))await setState(context,requestId,version,epoch,'unavailable','input_bound_reached');});return;}
  if(initial.windows.length===0){await withTransaction(input.session,async()=>{await lockAskLifecycle(context);if(await fenced(input))await setState(context,requestId,version,epoch,'unavailable','unsupported_answer');});return;}
  const reserved=await withTransaction(input.session,async()=>{await lockAskLifecycle(context);
   const current=await readCurrentAskInput(context,requestId,version,epoch,route!);if(!await fenced(input))return null;if(current===null||current.inputHash!==initial.inputHash||Date.parse(proof.validUntil)<=Date.parse(await now(context))){await setState(context,requestId,version,epoch,'unavailable',current?.inputBoundReached?'input_bound_reached':'processing_authority_unavailable');return null;}
   const previous=(await context.db.query<{dispatch_state:string}>('SELECT dispatch_state FROM crm_ask_financial_receipts WHERE workspace_id=$1 AND request_id=$2 AND stage=\'answer\'',[context.scope.workspaceId,requestId])).rows[0];if(previous!==undefined)return null;
   const purpose=current.proofInput.purpose;
   const inputTokens=Buffer.byteLength(JSON.stringify({question:current.question,windows:current.windows,groups:current.groups}))+1024,maxOutputTokens=4096;
   const cents=crmTokenCostCents(inputTokens,maxOutputTokens,purpose.inputTokenPriceMicros,purpose.outputTokenPriceMicros);
   if(inputTokens>1000000||cents===null||!Number.isSafeInteger(cents)||cents>2147483647||!await withinBudget(context,purpose,adapter.providerKey,cents)){await setState(context,requestId,version,epoch,'unavailable','budget_held');return null;}
   const at=await now(context),zone=await workspaceBusinessZone(context);
   const reservation=await reserveAttempt(context,{providerKey:adapter.providerKey,subjectKind:'crm_ask_answer',subjectId:requestId,attempt:1,at,businessTimeZone:zone,cents,modelName:purpose.modelVersion,maxInputTokens:inputTokens,maxOutputTokens});
   const receipt=(await context.db.query<{id:string}>(`INSERT INTO crm_ask_financial_receipts(workspace_id,request_id,request_version,request_epoch,stage,attempt,reservation_id,job_id,fencing_token,purpose_revision,purpose_snapshot,config_fingerprint,evaluation_fingerprint,authorization_fingerprint,input_hash,input_price_micros,output_price_micros,max_input_tokens,max_output_tokens,dispatch_state) VALUES($1,$2,$3,$4,'answer',1,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,'reserved') RETURNING id`,[context.scope.workspaceId,requestId,version,epoch,reservation.id,input.job.id,input.job.fencingToken,purpose.revision,JSON.stringify(purpose),current.proofInput.configFingerprint,purpose.evaluationFingerprint,current.proofInput.authorizationFingerprint,current.inputHash,purpose.inputTokenPriceMicros,purpose.outputTokenPriceMicros,inputTokens,maxOutputTokens])).rows[0]!;
   return {receiptId:receipt.id,reservationId:reservation.id,inputTokens,maxOutputTokens,purpose,inputHash:current.inputHash};
  });
  if(reserved===null)return;
  const dispatchProof=await verifyAskPurpose(runtime,initial.proofInput);
  const dispatch=await withTransaction(input.session,async()=>{await lockAskLifecycle(context);
   const current=await readCurrentAskInput(context,requestId,version,epoch,route!);
   let dispatchAuthority=false;try{dispatchAuthority=runtime.revalidatePurpose?await runtime.revalidatePurpose(context,initial.proofInput):runtime.allowControlledEvaluation===true;}catch{dispatchAuthority=false;}
   if(!dispatchAuthority||!unchanged()||current===null||dispatchProof===null||current.inputHash!==reserved.inputHash||!await fenced(input)||Date.parse(dispatchProof.validUntil)<=Date.parse(await now(context))||!await withinBudget(context,reserved.purpose,adapter.providerKey,0)){await settleAttempt(context,{reservationId:reserved.reservationId,at:await now(context),outcome:{kind:'released'}});await context.db.query("UPDATE crm_ask_financial_receipts SET dispatch_state='released' WHERE workspace_id=$1 AND id=$2 AND dispatch_state='reserved'",[context.scope.workspaceId,reserved.receiptId]);if(await fenced(input))await setState(context,requestId,version,epoch,'unavailable',current?.inputBoundReached?'input_bound_reached':'processing_authority_unavailable');return null;}
   if(!await markCalling(context,reserved.reservationId))return null;
   await context.db.query("UPDATE crm_ask_financial_receipts SET dispatch_state='calling' WHERE workspace_id=$1 AND id=$2 AND dispatch_state='reserved'",[context.scope.workspaceId,reserved.receiptId]);
   return structuredClone(current);
  });
  if(dispatch===null)return;
  let outcome:Awaited<ReturnType<AskAnswerAdapter['run']>>;
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const timed=new Promise<Awaited<ReturnType<AskAnswerAdapter['run']>>>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({acceptance:'unknown',usage:null,answer:null});},Math.max(1,Math.min(60000,runtime.providerTimeoutMs??60000)));});
  try{outcome=!unchanged()?{acceptance:'not_accepted',usage:{inputTokens:0,outputTokens:0},answer:null}:structuredClone(await Promise.race([adapter.run({question:dispatch.question,windows:structuredClone(dispatch.windows),groups:structuredClone(dispatch.groups),maxOutputTokens:reserved.maxOutputTokens,signal:controller.signal}),timed]));}catch{outcome={acceptance:'unknown',usage:null,answer:null};}finally{if(timer!==undefined)clearTimeout(timer);}
  const finalProof=await verifyAskPurpose(runtime,initial.proofInput);
  await withTransaction(input.session,async()=>{await lockAskLifecycle(context);
   const current=await readCurrentAskInput(context,requestId,version,epoch,route!);
   // Money remains recoverable even when private history is deleted or the actor is revoked.
   await lockMonthlySpend(context);
   const usage=z.strictObject({inputTokens:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),outputTokens:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).safeParse(outcome.usage);
   const cents=usage.success?crmTokenCostCents(usage.data.inputTokens,usage.data.outputTokens,reserved.purpose.inputTokenPriceMicros,reserved.purpose.outputTokenPriceMicros):null;
   const unknown=outcome.acceptance==='unknown'||!usage.success||cents===null||!Number.isSafeInteger(cents)||cents>2147483647;
   await settleAttempt(context,{reservationId:reserved.reservationId,at:await now(context),outcome:unknown?{kind:'estimated'}:{kind:'settled',cents:outcome.acceptance==='not_accepted'?0:cents!}});
   await context.db.query('UPDATE crm_ask_financial_receipts SET dispatch_state=$3 WHERE workspace_id=$1 AND id=$2 AND dispatch_state=\'calling\'',[context.scope.workspaceId,reserved.receiptId,unknown?'unknown_acceptance':'settled']);
   let currentAuthority=true;try{if(runtime.revalidatePurpose)currentAuthority=await runtime.revalidatePurpose(context,initial.proofInput)===true;}catch{currentAuthority=false;}
   if(!await fenced(input))return;
   if(unknown){await setState(context,requestId,version,epoch,'unknown_acceptance','provider_acceptance_unknown');return;}
   if(!currentAuthority||current===null||finalProof===null||current.inputHash!==reserved.inputHash||Date.parse(finalProof.validUntil)<=Date.parse(await now(context))){const livePurpose=await readAskPurpose(context,'answer');await setState(context,requestId,version,epoch,'stale',livePurpose===null||askFingerprint({purpose:livePurpose,route:initial.proofInput.route})!==initial.proofInput.configFingerprint?'purpose_changed':'source_changed');return;}
   if(current.inputBoundReached){await setState(context,requestId,version,epoch,'unavailable','input_bound_reached');return;}
   const candidate=candidateSchema.safeParse(outcome.answer);
   if(outcome.acceptance!=='accepted'||!candidate.success||!usage.success||usage.data.inputTokens>reserved.inputTokens||usage.data.outputTokens>reserved.maxOutputTokens){await setState(context,requestId,version,epoch,'unavailable','processing_failed');return;}
   const permitted=new Map(current.windows.map(window=>[window.id,window]));
   for(const claim of candidate.data.claims){if(claim.kind!=='extractive'||new Set(claim.citationWindowIds).size!==claim.citationWindowIds.length||claim.citationWindowIds.some(id=>!permitted.get(id)?.text.includes(claim.text))){await setState(context,requestId,version,epoch,'unavailable','unsupported_answer');return;}}
   const result=askGroundedAnswerSchema.parse({answeredAt:await now(context),claims:candidate.data.claims.map(claim=>({...claim,verification:'supported'})),conflicts:current.conflicts,missingEvidence:[...current.conflicts.length>0?['conflict_unresolved']:[],...candidate.data.abstained?['no_supported_answer']:[],...current.retrievalPartial?['input_partial']:[]],abstained:candidate.data.abstained,coverage:{acquisition:'unverified',semantic:finalProof.evaluationKind==='actual'?'bounded_evaluated':'unverified',input:current.retrievalPartial?'partial':'complete',sourceCeiling:10,windowCeiling:1000,groupCeiling:10,evaluationFingerprint:reserved.purpose.evaluationFingerprint}});
   await context.db.query("UPDATE crm_ask_requests SET state='complete',reason=NULL,result=$5::jsonb,result_at=clock_timestamp(),updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND version=$3 AND epoch=$4 AND state='pending'",[context.scope.workspaceId,requestId,version,epoch,JSON.stringify(result)]);
  });
 }};
}

// Reproduced normal-stop draft ending in an opening parenthesis. This narrow
// refusal is not a general grammar or semantic-support validator; never repair it.
const agentCandidate=z.strictObject({claims:z.array(z.strictObject({text:z.string().min(1).max(1000).refine(text=>!text.trimEnd().endsWith('(')),kind:z.enum(['fact','inference','conflict']),construction:askClaimConstructionSchema.optional(),citationWindowIds:z.array(z.uuid()).max(10),exactResultToolCallIds:z.array(z.string().min(1).max(100)).max(10).optional()}).refine(claim=>claim.citationWindowIds.length>0||(claim.exactResultToolCallIds?.length??0)>0)).max(20),abstained:z.boolean()}).refine(value=>!value.abstained||value.claims.length===0);
const toolCall=z.strictObject({id:z.string().min(1).max(100),name:z.enum(['read_exact','read_selected','search_selected','search_history','browse_history','read_conversation','resolve_records']),input:z.unknown()});
/** Internal model evidence authority never changes canonical proof or publication. */

async function handleAskAgent(input:JobHandlerInput,runtime:AskAnswerComposition,located:NonNullable<Awaited<ReturnType<typeof locate>>>){
 const {context,requestId,version,epoch}=located,agent=runtime.agent,limits=runtime.agentLimits;
 const update=async(state:string,reason:string|null)=>withTransaction(input.session,async()=>{await lockAskLifecycle(context);if(await fenced(input))await setState(context,requestId,version,epoch,state,reason);});
 if(!agent||!limits||!Number.isInteger(limits.maxSteps)||limits.maxSteps<1||limits.maxSteps>32||!Number.isInteger(limits.maxInputBytes)||limits.maxInputBytes<1||limits.maxInputBytes>1000000||!Number.isInteger(limits.maxOutputTokens)||limits.maxOutputTokens<1||limits.maxOutputTokens>4096||!Number.isInteger(limits.deadlineMs)||limits.deadlineMs<1||limits.deadlineMs>60000){await update('unavailable','processing_authority_unavailable');return;}
 const originalRun=agent.runStep;const route={endpointId:agent.endpointId,modelVersion:agent.modelVersion,providerKey:agent.providerKey},run=originalRun.bind(Object.freeze({...agent})),originalInputBound=agent.inputBound,started=Date.now();
 const unchanged=()=>runtime.agent===agent&&agent.endpointId===route.endpointId&&agent.modelVersion===route.modelVersion&&agent.providerKey===route.providerKey&&agent.runStep===originalRun&&agent.inputBound===originalInputBound;
 const current=async()=>withTransaction(input.session,async()=>{await lockAskLifecycle(context);if(!await fenced(input))return null;const row=(await context.db.query<{cancelled_at:Date|null}>('SELECT cancelled_at FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,requestId])).rows[0];if(row?.cancelled_at)return null;return readCurrentAskInput(context,requestId,version,epoch,route);});
 const initial=await current();if(!initial)return;if(initial.identityAmbiguous){await update('unavailable','identity_clarification_required');return;}
 const initialAttribution=await readAskConversationAttribution(context,[...new Map(initial.windows.map(window=>[`${window.source.kind}:${window.source.sourceId}`,window.source])).values()]);if(initialAttribution===null){await update('stale','source_changed');return;}
 const transcript:unknown[]=[...initial.history,{attribution:initialAttribution,windows:initial.windows.map(window=>modelWindow({id:window.id,ordinal:window.ordinal,source:window.source,text:window.text})),coverage:initial.coverage,scope:initial.scopeDescriptor}];
 let retrievalSummary:unknown;let expectedInputHash=initial.inputHash;
 const executionKey={requestId,version,epoch};
 const intent=initial.agentScope??{kind:'selected' as const,sources:initial.scope.sources};
 const exactResults:{toolCallId:string;operation:'opportunities'|'tasks'|'reply_status';valueHash:string;value:unknown}[]=[];
 for(let step=1;step<=limits.maxSteps;step++){
  const snapshot=await current();if(!snapshot||snapshot.inputHash!==expectedInputHash||snapshot.baseInputHash!==initial.baseInputHash){await update('stale','source_changed');return;}
  if(snapshot.identityAmbiguous){await update('unavailable','identity_clarification_required');return;}
  const proof=await verifyAskPurpose(runtime,snapshot.proofInput);if(!proof||!unchanged()||proof.evaluationKind==='actual'&&(askFingerprint(snapshot.proofInput.purpose.agentLimits??null)!==askFingerprint(limits)||Object.entries(CRM_SUPPORTED_AGENT_ASK_VERSIONS).some(([key,value])=>snapshot.proofInput.purpose[key as keyof typeof CRM_SUPPORTED_AGENT_ASK_VERSIONS]!==value))){await update('unavailable','processing_authority_unavailable');return;}
  let bound:{inputBytes:number;maxInputTokens:number}|null=null;
  try{
   // Legacy/custom adapters may omit this optional method. Ordinary SDK adapters
   // always count their full actual system/tools/messages via the shared composer.
   const legacyBytes=Buffer.byteLength(JSON.stringify({question:snapshot.question,transcript}))+2048;
   bound=originalInputBound?originalInputBound.call(agent,{question:snapshot.question,transcript:structuredClone(transcript),maxOutputTokens:limits.maxOutputTokens,remainingSteps:limits.maxSteps-step+1}):{inputBytes:legacyBytes,maxInputTokens:legacyBytes};
  }catch{/* Invalid composition refuses before any financial reservation or call. */}
  if(bound===null||!Number.isSafeInteger(bound.inputBytes)||bound.inputBytes<0||!Number.isSafeInteger(bound.maxInputTokens)||bound.maxInputTokens<0||bound.maxInputTokens>1000000){await update('unavailable','processing_failed');return;}
  if(!unchanged()){await update('stale','source_changed');return;}
  const inputTokens=bound.maxInputTokens;
  if(bound.inputBytes>limits.maxInputBytes||Date.now()-started>=limits.deadlineMs){await update('unavailable','input_bound_reached');return;}
  const reserved=await withTransaction(input.session,async()=>{await lockAskLifecycle(context);
   const live=await readCurrentAskInput(context,requestId,version,epoch,route);if(!live||live.inputHash!==snapshot.inputHash||!await fenced(input))return null;
   const cancellation=(await context.db.query<{cancelled_at:Date|null}>('SELECT cancelled_at FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,requestId])).rows[0];if(cancellation?.cancelled_at)return null;
   const previous=(await context.db.query<{reservation_id:string;dispatch_state:string}>('SELECT reservation_id,dispatch_state FROM crm_ask_financial_receipts WHERE workspace_id=$1 AND request_id=$2 AND request_version=$3 AND request_epoch=$4 AND stage=\'answer\' ORDER BY attempt',[context.scope.workspaceId,requestId,version,epoch])).rows;
   if(previous.some(receipt=>['calling','unknown_acceptance'].includes(receipt.dispatch_state))){for(const receipt of previous.filter(receipt=>receipt.dispatch_state==='calling')){await lockMonthlySpend(context);await settleAttempt(context,{reservationId:receipt.reservation_id,at:await now(context),outcome:{kind:'estimated'}});await context.db.query("UPDATE crm_ask_financial_receipts SET dispatch_state='unknown_acceptance' WHERE workspace_id=$1 AND reservation_id=$2 AND dispatch_state='calling'",[context.scope.workspaceId,receipt.reservation_id]);}await setState(context,requestId,version,epoch,'unknown_acceptance','provider_acceptance_unknown');return null;}
   // Completed steps cannot be replayed after a process restart: transcript is deliberately not recovered from generated text.
   if(previous.length!==step-1){await setState(context,requestId,version,epoch,'unavailable','processing_failed');return null;}
   const cents=crmTokenCostCents(inputTokens,limits.maxOutputTokens,live.proofInput.purpose.inputTokenPriceMicros,live.proofInput.purpose.outputTokenPriceMicros);if(cents===null||!await withinBudget(context,live.proofInput.purpose,route.providerKey,cents)){await setState(context,requestId,version,epoch,'unavailable','budget_held');return null;}
   let authorized=false;try{authorized=runtime.revalidatePurpose?await runtime.revalidatePurpose(context,live.proofInput):runtime.allowControlledEvaluation===true;}catch{/* Closed. */}
   if(!authorized||Date.parse(proof.validUntil)<=Date.parse(await now(context))||!unchanged()){await setState(context,requestId,version,epoch,'unavailable','processing_authority_unavailable');return null;}
   const at=await now(context),zone=await workspaceBusinessZone(context),purpose=live.proofInput.purpose;
   const reservation=await reserveAttempt(context,{providerKey:route.providerKey,subjectKind:'crm_ask_answer',subjectId:requestId,attempt:step,at,businessTimeZone:zone,cents,modelName:purpose.modelVersion,maxInputTokens:inputTokens,maxOutputTokens:limits.maxOutputTokens});
   const receipt=(await context.db.query<{id:string}>(`INSERT INTO crm_ask_financial_receipts(workspace_id,request_id,request_version,request_epoch,stage,attempt,reservation_id,job_id,fencing_token,purpose_revision,purpose_snapshot,config_fingerprint,evaluation_fingerprint,authorization_fingerprint,input_hash,input_price_micros,output_price_micros,max_input_tokens,max_output_tokens,dispatch_state) VALUES($1,$2,$3,$4,'answer',$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,'reserved') RETURNING id`,[context.scope.workspaceId,requestId,version,epoch,step,reservation.id,input.job.id,input.job.fencingToken,purpose.revision,JSON.stringify(purpose),live.proofInput.configFingerprint,purpose.evaluationFingerprint,live.proofInput.authorizationFingerprint,askFingerprint({input:live.inputHash,transcript:askFingerprint(transcript)}),purpose.inputTokenPriceMicros,purpose.outputTokenPriceMicros,inputTokens,limits.maxOutputTokens])).rows[0]!;
   if(!await markCalling(context,reservation.id))return null;
   await context.db.query("UPDATE crm_ask_financial_receipts SET dispatch_state='calling' WHERE workspace_id=$1 AND id=$2",[context.scope.workspaceId,receipt.id]);
   await context.db.query("UPDATE crm_ask_requests SET progress_stage='calling' WHERE workspace_id=$1 AND id=$2 AND state='pending'",[context.scope.workspaceId,requestId]);
   return {id:receipt.id,reservationId:reservation.id,purpose};
  });if(!reserved)return;
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<Awaited<ReturnType<typeof run>>>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({acceptance:'unknown',usage:null,answer:null,toolCalls:[]});},Math.max(1,limits.deadlineMs-(Date.now()-started)));});
  const modelStarted=performance.now();
  let outcome:Awaited<ReturnType<typeof run>>;try{outcome=structuredClone(await Promise.race([run({question:snapshot.question,transcript:structuredClone(transcript),maxOutputTokens:limits.maxOutputTokens,remainingSteps:limits.maxSteps-step+1,signal:controller.signal}),timeout]));}catch{outcome={acceptance:'unknown',usage:null,answer:null,toolCalls:[]};}finally{if(timer)clearTimeout(timer);}
  const modelDurationMs=Math.max(0,Math.floor(performance.now()-modelStarted));
  const usage=z.strictObject({inputTokens:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),outputTokens:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).safeParse(outcome.usage),cost=usage.success?crmTokenCostCents(usage.data.inputTokens,usage.data.outputTokens,reserved.purpose.inputTokenPriceMicros,reserved.purpose.outputTokenPriceMicros):null;
  const unknown=outcome.acceptance==='unknown'||!usage.success||cost===null||!Number.isSafeInteger(cost)||cost>2147483647;
  await withTransaction(input.session,async()=>{await lockAskLifecycle(context);await lockMonthlySpend(context);await settleAttempt(context,{reservationId:reserved.reservationId,at:await now(context),outcome:unknown?{kind:'estimated'}:{kind:'settled',cents:outcome.acceptance==='not_accepted'?0:cost!}});await context.db.query("UPDATE crm_ask_financial_receipts SET dispatch_state=$3 WHERE workspace_id=$1 AND id=$2 AND dispatch_state='calling'",[context.scope.workspaceId,reserved.id,unknown?'unknown_acceptance':'settled']);if(await fenced(input))await context.db.query("UPDATE crm_ask_requests SET completed_steps=$3,progress_stage='validating' WHERE workspace_id=$1 AND id=$2 AND state='pending'",[context.scope.workspaceId,requestId,step]);await recordCrmAuditEvent(context,{action:'crm.ask_model_step',subjectKind:'crm_ask_request',subjectId:requestId,detail:{requestVersion:version,requestEpoch:epoch,step,receiptId:reserved.id,durationMs:modelDurationMs,acceptance:unknown?'unknown':outcome.acceptance,inputTokens:usage.success?usage.data.inputTokens:null,outputTokens:usage.success?usage.data.outputTokens:null,requestedToolNames:outcome.toolCalls.slice(0,20).flatMap(call=>{const parsed=askDiagnosticToolNameSchema.safeParse(call.name);return parsed.success?[parsed.data]:[];})}});});
  if(unknown){await update('unknown_acceptance','provider_acceptance_unknown');return;}
  if(outcome.acceptance!=='accepted'||!usage.success||usage.data.inputTokens>inputTokens||usage.data.outputTokens>limits.maxOutputTokens){await update('unavailable','processing_failed');return;}
  let live=await current();const liveProof=await verifyAskPurpose(runtime,snapshot.proofInput);if(!live||live.inputHash!==snapshot.inputHash||!liveProof||!unchanged()){await update('stale','source_changed');return;}
  const calls=z.array(toolCall).max(8).safeParse(outcome.toolCalls);if(!calls.success||new Set(calls.data.map(call=>call.id)).size!==calls.data.length){await update('unavailable','processing_failed');return;}
  if(calls.data.length){
   if(calls.data.some(call=>call.name==='read_exact'&&exactResults.some(exact=>exact.toolCallId===call.id))){await update('unavailable','unsupported_answer');return;}
   // The last paid generation is reserved for synthesis, not another retrieval round.
   if(step===limits.maxSteps){await update('unavailable','step_bound_reached');return;}
   for(const call of calls.data){const checked=await current();if(!checked||checked.inputHash!==expectedInputHash){await update('stale','source_changed');return;}live=checked;let value:unknown;
    if(call.name==='read_selected'){const args=z.strictObject({windowIds:z.array(z.uuid()).min(1).max(20)}).safeParse(call.input);if(!args.success||args.data.windowIds.some(id=>!checked.windows.some(window=>window.id===id))){await update('unavailable','unsupported_answer');return;}value=live.windows.filter(window=>args.data.windowIds.includes(window.id)).map(modelWindow);}
    else if(call.name==='search_selected'){const args=z.strictObject({query:z.string().trim().min(1).max(300),limit:z.number().int().min(1).max(20)}).safeParse(call.input);if(!args.success){await update('unavailable','unsupported_answer');return;}const ranked=await rankAskAgentHybrid(input,runtime,live,args.data.query,args.data.limit,started+limits.deadlineMs);if(ranked.unknown){await update('unknown_acceptance','provider_acceptance_unknown');return;}value=ranked.value&&'windows' in ranked.value?{...ranked.value,windows:ranked.value.windows.map(modelWindow)}:ranked.value;if(ranked.value&&'retrieval' in ranked.value){const {windows:_,retrieval,...summary}=ranked.value;void _;retrievalSummary={method:retrieval,...summary};}}
    else if(call.name==='resolve_records'){
     const args=z.strictObject({query:z.string().trim().max(200).optional(),kind:z.enum(['firm','person']).optional(),limit:z.number().int().min(1).max(20),afterId:z.uuid().optional()}).safeParse(call.input);if(!args.success){await update('unavailable','unsupported_answer');return;}
     const records=await resolveAskRecords(context,intent,args.data);if(!records){await update('unavailable','source_unavailable');return;}
     const admitted=await withTransaction(input.session,async()=>{await lockAskLifecycle(context);const before=await readCurrentAskInput(context,requestId,version,epoch,route);if(!before||before.inputHash!==expectedInputHash||!await fenced(input))return false;for(const record of records.records)if(!await admitAskRecord(context,executionKey,{kind:record.kind,recordId:record.recordId},record))return false;return true;});if(!admitted){await update('stale','source_changed');return;}live=await current();if(!live){await update('stale','source_changed');return;}expectedInputHash=live.inputHash;value=records;
     if(records.selection==='ambiguous'||records.selection==='unresolved'){await recordCrmAuditEvent(context,{action:'crm.ask_tool_executed',subjectKind:'crm_ask_request',subjectId:requestId,detail:{requestVersion:version,requestEpoch:epoch,step,name:call.name}});await withTransaction(input.session,async()=>{await lockAskLifecycle(context);const before=await readCurrentAskInput(context,requestId,version,epoch,route);if(!before||before.inputHash!==expectedInputHash||!await fenced(input))return;await context.db.query("UPDATE crm_ask_requests SET clarification=$5::jsonb,state='unavailable',reason='identity_clarification_required',progress_stage='unavailable' WHERE workspace_id=$1 AND id=$2 AND version=$3 AND epoch=$4 AND state='pending' AND cancelled_at IS NULL",[context.scope.workspaceId,requestId,version,epoch,JSON.stringify({kind:'identity_ambiguous',query:args.data.query??'',recordKind:args.data.kind==='person'?'people':'firms',scope:intent,matches:records.records,truncated:!records.scanComplete})]);});return;}

    }
    else if(call.name==='search_history'||call.name==='browse_history'||call.name==='read_conversation'){
     const cursor=z.strictObject({kind:z.enum(['selected_note','mail','call_transcript','meeting_transcript']),sourceId:z.uuid()});
     const args=call.name==='search_history'?z.strictObject({query:z.string().trim().min(1).max(300),limit:z.number().int().min(1).max(20),after:cursor.optional()}).safeParse(call.input):call.name==='browse_history'?z.strictObject({limit:z.number().int().min(1).max(5),after:cursor.optional()}).safeParse(call.input):z.strictObject({sourceId:z.uuid(),kind:z.enum(['selected_note','mail','call_transcript','meeting_transcript']),limit:z.number().int().min(1).max(10)}).safeParse(call.input);
     if(!args.success){await update('unavailable','unsupported_answer');return;}
     const raw=args.data;
     if('sourceId' in raw&&!live.scope.sources.some(source=>source.sourceId===raw.sourceId&&source.kind===raw.kind)){await update('unavailable','unsupported_answer');return;}
     let found:NonNullable<Awaited<ReturnType<typeof browseAskHistory>>>|NonNullable<Awaited<ReturnType<typeof readAskConversationSources>>>|Omit<NonNullable<Awaited<ReturnType<typeof searchAskHistory>>>,'retrieval'|'semantic'> & {retrieval:'ranked_lexical'|'hybrid_rrf';semantic:'unavailable'|'unverified'}|null='query' in raw&&typeof raw.query==='string'?await searchAskHistory(context,intent,{...raw,query:raw.query,deadlineAt:started+limits.deadlineMs}):!('sourceId' in raw)?await browseAskHistory(context,intent,{...raw,deadlineAt:started+limits.deadlineMs}):await readAskConversationSources(context,intent,{...raw,anchor:live.scope.sources.find(source=>source.sourceId===raw.sourceId&&source.kind===raw.kind)!,deadlineAt:started+limits.deadlineMs});
     if(!found){await update('unavailable','source_unavailable');return;}
     if('query' in raw&&typeof raw.query==='string'&&found.matches!==null){const ranked=await rankAskHistoryHybrid(input,runtime,live,found,raw.query,raw.limit,started+limits.deadlineMs);if(ranked.unknown){await update('unknown_acceptance','provider_acceptance_unknown');return;}found=ranked.history;}
     const known=new Set(live.scope.sources.map(source=>`${source.kind}:${source.sourceId}`));let room=10-known.size;const sources=found.sources.filter(source=>known.has(`${source.kind}:${source.sourceId}`)||room-->0);
     const admitted=await withTransaction(input.session,async()=>{await lockAskLifecycle(context);const before=await readCurrentAskInput(context,requestId,version,epoch,route);return !!before&&before.inputHash===expectedInputHash&&await fenced(input)&&await admitAskSources(context,executionKey,sources.map(copiedAskSource));});
     if(!admitted){await update('stale','source_changed');return;}live=await current();if(!live){await update('stale','source_changed');return;}expectedInputHash=live.inputHash;
     const keys=new Set(sources.map(source=>`${source.kind}:${source.sourceId}`));let windows=live.windows.filter(window=>keys.has(`${window.source.kind}:${window.source.sourceId}`)&&(found.matches===null||found.matches.some(match=>match.source.kind===window.source.kind&&match.source.sourceId===window.source.sourceId&&match.locator===window.source.locator))).sort((a,b)=>sources.findIndex(source=>source.kind===a.source.kind&&source.sourceId===a.source.sourceId)-sources.findIndex(source=>source.kind===b.source.kind&&source.sourceId===b.source.sourceId)||a.ordinal-b.ordinal);
     const previewWindowCount=windows.length;
     if(call.name==='browse_history'){const seen=new Set<string>();windows=windows.filter(window=>{const key=`${window.source.kind}:${window.source.sourceId}`;if(seen.has(key))return false;seen.add(key);return true;});}
     windows=windows.slice(0,20);
     const attribution=await readAskConversationAttribution(context,sources);if(attribution===null){await update('stale','source_changed');return;}
     const partial=found.partial||sources.length<found.sources.length||call.name==='browse_history'&&previewWindowCount>windows.length;
     const sourceCeilingReached=sources.length<found.sources.length;
     const lastAdmitted=sources.at(-1);
     const nextAfter=call.name==='browse_history'&&sourceCeilingReached?(lastAdmitted?{kind:lastAdmitted.kind,sourceId:lastAdmitted.sourceId}:'after' in raw?raw.after??null:null):'nextAfter' in found?found.nextAfter:null;
     value={windows:windows.map(modelWindow),scope:live.scopeDescriptor,...call.name==='browse_history'?{preview:true,previewWindowLimit:1,sourceCeilingReached}:{},...attribution===undefined?{}:{attribution},partial,...'retrieval' in found?{retrieval:found.retrieval,semantic:found.semantic,scannedCandidates:found.scannedCandidates,nextAfter}:{}};
     if('retrieval' in found)retrievalSummary={method:found.retrieval,semantic:found.semantic,partial};
    }
    else{
     if(exactResults.length>=20){await update('unavailable','input_bound_reached');return;}const args=z.strictObject({operation:z.enum(['opportunities','tasks','reply_status']),firmId:z.uuid().optional()}).safeParse(call.input);if(!args.success){await update('unavailable','unsupported_answer');return;}
     if(args.data.firmId!==undefined&&((intent.kind==='firm'&&args.data.firmId!==intent.firmId)||(intent.kind==='selected'&&!live.toolFirmIds.includes(args.data.firmId)))){await update('unavailable','unsupported_answer');return;}
     const exactInput={...args.data,limit:20,...args.data.operation==='opportunities'?{status:'all' as const}:{}};
     const observed=await withTransaction(input.session,async()=>{await lockAskLifecycle(context);return readAskScopedExactObservation(context,intent,exactInput);});if(observed===null){await update('unavailable','source_unavailable');return;}value=observed.value;
     if(observed.taskDependencies.length>0){
      const admitted=await withTransaction(input.session,async()=>{await lockAskLifecycle(context);const existing=await readAskTaskDependencyLedger(context,executionKey);if(new Set([...existing,...observed.taskDependencies].map(task=>`${task.kind}:${task.taskId}`)).size>1000)return 'bound' as const;if(!await admitAskTaskDependencies(context,executionKey,observed.taskDependencies))return false;const refreshed=await readAskScopedExact(context,intent,exactInput);if(refreshed===null||askFingerprint(refreshed)!==askFingerprint(value))return false;return await fenced(input);});
      if(admitted==='bound'){await update('unavailable','input_bound_reached');return;}if(!admitted){await update('stale','source_changed');return;}live=await current();if(!live||live.baseInputHash!==initial.baseInputHash){await update('stale','source_changed');return;}expectedInputHash=live.inputHash;
     }
     if(intent.kind!=='selected'){
      const records=z.object({records:z.array(z.object({firmId:z.uuid().optional()}).passthrough()).max(50).optional()}).passthrough().safeParse(value);
      const firmIds=[...new Set([...(args.data.firmId===undefined?[]:[args.data.firmId]),...(records.success?records.data.records??[]:[]).flatMap(record=>record.firmId===undefined?[]:[record.firmId])])];
      const admitted=await withTransaction(input.session,async()=>{await lockAskLifecycle(context);const before=await readCurrentAskInput(context,requestId,version,epoch,route);if(!before||before.inputHash!==expectedInputHash||!await fenced(input))return false;for(const firmId of firmIds)if(!await admitAskRecord(context,executionKey,{kind:'firm',recordId:firmId}))return false;return true;});
      if(!admitted){await update('stale','source_changed');return;}live=await current();if(!live){await update('stale','source_changed');return;}expectedInputHash=live.inputHash;
     }
     exactResults.push({toolCallId:call.id,operation:args.data.operation,valueHash:askFingerprint(value),value});if(Buffer.byteLength(JSON.stringify({exactResults}))>60000){await update('unavailable','input_bound_reached');return;}
     await withTransaction(input.session,async()=>{await lockAskLifecycle(context);const current=await readCurrentAskInput(context,requestId,version,epoch,route);if(!current||current.inputHash!==expectedInputHash||!await fenced(input))return;await context.db.query("UPDATE crm_ask_requests SET validated_progress=$5::jsonb WHERE workspace_id=$1 AND id=$2 AND version=$3 AND epoch=$4 AND state='pending' AND cancelled_at IS NULL",[context.scope.workspaceId,requestId,version,epoch,JSON.stringify({exactResults})]);});
    }
    if(call.name==='read_exact'&&typeof value==='object'&&value!==null&&!Array.isArray(value))value={...value,evidenceAuthority:{kind:'current_exact_crm_state',toolCallId:call.id,citationAuthority:'exact_result_only',conversationCitationAllowed:false}};
    await recordCrmAuditEvent(context,{action:'crm.ask_tool_executed',subjectKind:'crm_ask_request',subjectId:requestId,detail:{requestVersion:version,requestEpoch:epoch,step,name:call.name}});
    transcript.push({toolCallId:call.id,name:call.name,input:call.input,result:value});
   }continue;
  }
  const parsedCandidate=agentCandidate.safeParse(outcome.answer);
  const constructed=parsedCandidate.success?parsedCandidate.data.claims.map(claim=>claim.construction?constructAskClaim({construction:claim.construction,windows:live.windows,exactResults,claim}):claim):null;
  if(constructed===null||constructed.some(claim=>claim===null)){await update('unavailable','unsupported_answer');return;}
  const candidate=agentCandidate.safeParse({...parsedCandidate.data,claims:constructed});if(!candidate.success||candidate.data.claims.some(claim=>new Set(claim.citationWindowIds).size!==claim.citationWindowIds.length||claim.citationWindowIds.some(id=>!live.windows.some(window=>window.id===id))||new Set(claim.exactResultToolCallIds??[]).size!==(claim.exactResultToolCallIds??[]).length||(claim.exactResultToolCallIds??[]).some(id=>!exactResults.some(exact=>exact.toolCallId===id)))){await update('unavailable','unsupported_answer');return;}
  await withTransaction(input.session,async()=>{await lockAskLifecycle(context);const final=await readCurrentAskInput(context,requestId,version,epoch,route);let authority=false;try{authority=runtime.revalidatePurpose?await runtime.revalidatePurpose(context,snapshot.proofInput):runtime.allowControlledEvaluation===true;}catch{/* Closed. */}if(!authority||!final||final.inputHash!==expectedInputHash||!await fenced(input))return;
   const cancellation=(await context.db.query<{cancelled_at:Date|null}>('SELECT cancelled_at FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,requestId])).rows[0];if(cancellation?.cancelled_at)return;
   for(const exact of exactResults){const value=exact.value as {scope:{firmId?:string}};const refreshed=await readAskScopedExact(context,intent,{operation:exact.operation,...value.scope.firmId?{firmId:value.scope.firmId}:{},limit:20,...exact.operation==='opportunities'?{status:'all' as const}:{}});if(refreshed===null||askFingerprint(refreshed)!==exact.valueHash){await setState(context,requestId,version,epoch,'stale','source_changed');return;}}
   const result=askGroundedAnswerSchema.parse({resultVersion:'agent_v1',...retrievalSummary?{retrieval:retrievalSummary}:{},exactResults,answeredAt:await now(context),claims:candidate.data.claims.map(claim=>({...claim,verification:'cited_unverified'})),conflicts:final.conflicts,missingEvidence:[...final.identityUnresolved?['identity_unresolved']:[],...final.conflicts.length?['conflict_unresolved']:[],...candidate.data.claims.some(claim=>claim.kind==='inference')?['inference_unverified']:[],...final.retrievalPartial?['input_partial']:[]],abstained:candidate.data.abstained,coverage:{acquisition:'unverified',semantic:'unverified',input:final.retrievalPartial?'partial':'complete',sourceCeiling:10,windowCeiling:1000,groupCeiling:10,evaluationFingerprint:reserved.purpose.evaluationFingerprint}});
   await context.db.query("UPDATE crm_ask_requests SET state='complete',reason=NULL,result=$5::jsonb,result_at=clock_timestamp(),progress_stage='complete',updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND version=$3 AND epoch=$4 AND state='pending'",[context.scope.workspaceId,requestId,version,epoch,JSON.stringify(result)]);
  });return;
 }await update('unavailable','step_bound_reached');
}

/** Small exact-array cosine prototype, versioned per immutable canonical window. No extension prerequisite. */
async function rankAskAgentHybrid(input:JobHandlerInput,runtime:AskAnswerComposition,initial:NonNullable<Awaited<ReturnType<typeof readCurrentAskInput>>>,query:string,limit:number,deadlineAt:number){
 const located=await locate(input);if(!located)return {unknown:false,value:{windows:[],retrieval:'unavailable'}};
 const {context,requestId,version,epoch}=located;
 const lexical=(await context.db.query<{id:string}>(`SELECT id FROM unnest($1::uuid[],$2::text[]) AS windows(id,text) WHERE to_tsvector($5::regconfig,text) @@ websearch_to_tsquery($5::regconfig,$3) ORDER BY ts_rank_cd(to_tsvector($5::regconfig,text),websearch_to_tsquery($5::regconfig,$3)) DESC,id LIMIT $4`,[initial.windows.map(window=>window.id),initial.windows.map(window=>window.text),askLexicalQuery(query),limit,askLexicalConfiguration(query)])).rows.map(row=>row.id);
 const fallback=()=>({unknown:false,value:{windows:lexical.map(id=>initial.windows.find(window=>window.id===id)!),retrieval:'ranked_lexical',semantic:'unavailable',partial:true}});
 if(askLexicalConfiguration(query)==='simple')return fallback();
 const meter=await createAskEmbeddingMeter(input,runtime,initial,deadlineAt);if(!meter||initial.windows.length===0)return fallback();
 const {embed,purpose,route,adapter,proofInput}=meter;
 const queryVector=await embed(query,'embedding_query');if(!queryVector)return meter.unknown()?{unknown:true,value:null}:fallback();
 const candidates=initial.windows.slice(0,20);let indexed=0;
 for(const window of candidates){
  let stored=(await context.db.query<{vector:number[]}>('SELECT vector FROM crm_ask_window_vectors WHERE workspace_id=$1 AND window_id=$2 AND purpose_revision=$3 AND model_version=$4 AND input_hash=$5 AND config_fingerprint=$6 AND dimensions=$7',[context.scope.workspaceId,window.id,purpose.revision,route.modelVersion,window.textHash,proofInput.configFingerprint,adapter.dimensions])).rows[0];
  if(!stored){const vector=await embed(window.text,'embedding_document');if(meter.unknown())return {unknown:true,value:null};if(!vector)continue;
   await withTransaction(input.session,async()=>{await lockAskLifecycle(context);const current=await readCurrentAskInput(context,requestId,version,epoch,initial.proofInput.route);if(!current||current.inputHash!==initial.inputHash||!await fenced(input))return;await context.db.query(`INSERT INTO crm_ask_window_vectors(workspace_id,window_id,purpose_revision,model_version,input_hash,config_fingerprint,dimensions,vector) VALUES($1,$2,$3,$4,$5,$6,$7,$8::double precision[]) ON CONFLICT DO NOTHING`,[context.scope.workspaceId,window.id,purpose.revision,route.modelVersion,window.textHash,proofInput.configFingerprint,adapter.dimensions,vector]);});stored={vector};
  }if(stored)indexed++;
 }
 const semantic=(await context.db.query<{window_id:string;score:number}>(`SELECT v.window_id,sum(a.value*q.value)/nullif(sqrt(sum(a.value*a.value)*sum(q.value*q.value)),0) AS score FROM crm_ask_window_vectors v CROSS JOIN LATERAL unnest(v.vector) WITH ORDINALITY a(value,ordinal) JOIN LATERAL unnest($8::double precision[]) WITH ORDINALITY q(value,ordinal) ON q.ordinal=a.ordinal WHERE v.workspace_id=$1 AND v.window_id=ANY($2::uuid[]) AND v.purpose_revision=$3 AND v.model_version=$4 AND v.config_fingerprint=$5 AND v.dimensions=$6 AND v.input_hash=ANY($7::text[]) GROUP BY v.window_id HAVING sum(a.value*q.value)>0 ORDER BY score DESC,v.window_id LIMIT $9`,[context.scope.workspaceId,candidates.map(window=>window.id),purpose.revision,route.modelVersion,proofInput.configFingerprint,adapter.dimensions,candidates.map(window=>window.textHash),queryVector,limit])).rows.map(row=>row.window_id);
 const scores=new Map<string,number>();for(const ranking of [lexical,semantic])for(const [rank,id]of ranking.entries())scores.set(id,(scores.get(id)??0)+1/(60+rank+1));
 const ids=[...scores].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,limit).map(([id])=>id);
 return {unknown:false,value:{windows:ids.map(id=>initial.windows.find(window=>window.id===id)!),retrieval:'hybrid_rrf',semantic:'unverified',partial:indexed<initial.windows.length,embeddingModel:route.modelVersion,purposeRevision:purpose.revision}};
}

/** Recovery never depends on surviving source text, membership or purpose authority. */
async function recoverAgentReceipts(input:JobHandlerInput){
 const parsed=z.strictObject({requestId:z.uuid(),version:z.number().int().positive(),epoch:z.number().int().positive()}).safeParse(input.job.payload);if(!parsed.success)return false;
 const context=repositoryContext(input.scope,input.session),{requestId,version,epoch}=parsed.data;
 return withTransaction(input.session,async()=>{await lockAskLifecycle(context);const mode=(await context.db.query<{execution_version:string}>('SELECT execution_version FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[input.scope.workspaceId,requestId])).rows[0];if(mode?.execution_version!=='agent_v1'||!await fenced(input))return false;
 const rows=(await context.db.query<{id:string;reservation_id:string;dispatch_state:string;job_id:string;fencing_token:string}>("SELECT id,reservation_id,dispatch_state,job_id,fencing_token FROM crm_ask_financial_receipts WHERE workspace_id=$1 AND request_id=$2 AND request_version=$3 AND request_epoch=$4 AND dispatch_state IN ('reserved','calling','unknown_acceptance') ORDER BY created_at",[input.scope.workspaceId,requestId,version,epoch])).rows;
 const recover=rows.filter(row=>row.dispatch_state!=='calling'||row.job_id!==input.job.id||row.fencing_token!==input.job.fencingToken);if(recover.length===0)return false;
 await lockMonthlySpend(context);let unknown=false;
 for(const row of recover){const released=row.dispatch_state==='reserved';await settleAttempt(context,{reservationId:row.reservation_id,at:await now(context),outcome:released?{kind:'released'}:{kind:'estimated'}});await context.db.query("UPDATE crm_ask_financial_receipts SET dispatch_state=$3 WHERE workspace_id=$1 AND id=$2 AND dispatch_state IN ('reserved','calling')",[input.scope.workspaceId,row.id,released?'released':'unknown_acceptance']);unknown ||= !released;}
 await setState(context,requestId,version,epoch,unknown?'unknown_acceptance':'unavailable',unknown?'provider_acceptance_unknown':'processing_authority_unavailable');return true;
 });
}

async function createAskEmbeddingMeter(input:JobHandlerInput,runtime:AskAnswerComposition,initial:NonNullable<Awaited<ReturnType<typeof readCurrentAskInput>>>,deadlineAt:number){
 const located=await locate(input);if(!located)return null;const {context,requestId,version,epoch}=located;
 const configuredAdapter=runtime.embedding;if(!configuredAdapter)return null;const adapter=configuredAdapter;
 const route={endpointId:adapter.endpointId,modelVersion:adapter.modelVersion,providerKey:adapter.providerKey};
 const configuredPurpose=await readAskPurpose(context,'embedding');if(!configuredPurpose||configuredPurpose.endpointId!==route.endpointId||configuredPurpose.modelVersion!==route.modelVersion)return null;const purpose=configuredPurpose;
 const originalEmbed=adapter.embed,invoke=originalEmbed.bind(Object.freeze({...adapter}));
 const proofInput={...initial.proofInput,stage:'embedding_query' as const,purpose,route,configFingerprint:askFingerprint({purpose,route})};
 const proof=await verifyAskPurpose(runtime,proofInput);if(!proof||proof.evaluationKind==='actual'&&purpose.embeddingDimensions!==adapter.dimensions)return null;
 let anyUnknown=false;
 async function embed(text:string,stage:'embedding_query'|'embedding_document'){
  const bytes=Buffer.byteLength(text)+1024;if(bytes>40000||Date.now()>=deadlineAt)return null;
  const stageProof={...proofInput,stage};const verified=await verifyAskPurpose(runtime,stageProof);if(!verified)return null;
  const reserved=await withTransaction(input.session,async()=>{await lockAskLifecycle(context);
   const current=await readCurrentAskInput(context,requestId,version,epoch,initial.proofInput.route);if(!current||current.inputHash!==initial.inputHash||!await fenced(input))return null;
   const currentPurpose=await readAskPurpose(context,'embedding');if(!currentPurpose||askFingerprint(currentPurpose)!==askFingerprint(purpose)||Date.parse(verified.validUntil)<=Date.parse(await now(context))||runtime.embedding!==adapter||adapter.embed!==originalEmbed)return null;
   let authority=false;try{authority=runtime.revalidatePurpose?await runtime.revalidatePurpose(context,stageProof):runtime.allowControlledEvaluation===true;}catch{/* Closed. */}if(!authority)return null;
   const prior=(await context.db.query<{id:string;reservation_id:string;dispatch_state:string}>('SELECT id,reservation_id,dispatch_state FROM crm_ask_financial_receipts WHERE workspace_id=$1 AND request_id=$2 AND stage IN (\'embedding_query\',\'embedding_document\') ORDER BY created_at',[context.scope.workspaceId,requestId])).rows;
   if(prior.some(row=>['calling','unknown_acceptance'].includes(row.dispatch_state))){for(const row of prior.filter(row=>row.dispatch_state==='calling')){await lockMonthlySpend(context);await settleAttempt(context,{reservationId:row.reservation_id,at:await now(context),outcome:{kind:'estimated'}});await context.db.query("UPDATE crm_ask_financial_receipts SET dispatch_state='unknown_acceptance' WHERE workspace_id=$1 AND id=$2 AND dispatch_state='calling'",[context.scope.workspaceId,row.id]);}anyUnknown=true;return null;}
   const attempt=prior.length+1;if(attempt>32)return null;
   const cents=crmTokenCostCents(bytes,0,purpose.inputTokenPriceMicros,purpose.outputTokenPriceMicros);if(cents===null||!await withinBudget(context,purpose,route.providerKey,cents))return null;
   const at=await now(context),zone=await workspaceBusinessZone(context),reservation=await reserveAttempt(context,{providerKey:route.providerKey,subjectKind:'crm_ask_embedding',subjectId:requestId,attempt,at,businessTimeZone:zone,cents,modelName:purpose.modelVersion,maxInputTokens:bytes,maxOutputTokens:1});
   const receipt=(await context.db.query<{id:string}>(`INSERT INTO crm_ask_financial_receipts(workspace_id,request_id,request_version,request_epoch,stage,attempt,reservation_id,job_id,fencing_token,purpose_revision,purpose_snapshot,config_fingerprint,evaluation_fingerprint,authorization_fingerprint,input_hash,input_price_micros,output_price_micros,max_input_tokens,max_output_tokens,dispatch_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,1,'reserved') RETURNING id`,[context.scope.workspaceId,requestId,version,epoch,stage,attempt,reservation.id,input.job.id,input.job.fencingToken,purpose.revision,JSON.stringify(purpose),stageProof.configFingerprint,purpose.evaluationFingerprint,stageProof.authorizationFingerprint,askFingerprint({requestInput:initial.inputHash,textHash:askFingerprint(text)}),purpose.inputTokenPriceMicros,purpose.outputTokenPriceMicros,bytes])).rows[0]!;
   if(!await markCalling(context,reservation.id))return null;await context.db.query("UPDATE crm_ask_financial_receipts SET dispatch_state='calling' WHERE workspace_id=$1 AND id=$2",[context.scope.workspaceId,receipt.id]);return {id:receipt.id,reservationId:reservation.id};
  });if(!reserved)return null;
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const timed=new Promise<Awaited<ReturnType<typeof invoke>>>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({acceptance:'unknown',usage:null,vector:null});},Math.max(1,Math.min(30000,deadlineAt-Date.now())));});
  let outcome:Awaited<ReturnType<typeof invoke>>;try{outcome=structuredClone(await Promise.race([invoke({text,signal:controller.signal}),timed]));}catch{outcome={acceptance:'unknown',usage:null,vector:null};}finally{if(timer)clearTimeout(timer);}
  const usage=z.strictObject({inputTokens:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),outputTokens:z.literal(0)}).safeParse(outcome.usage),cost=usage.success?crmTokenCostCents(usage.data.inputTokens,0,purpose.inputTokenPriceMicros,purpose.outputTokenPriceMicros):null;
  const unknown=outcome.acceptance==='unknown'||!usage.success||cost===null||!Number.isSafeInteger(cost)||cost>2147483647;anyUnknown ||= unknown;
  await withTransaction(input.session,async()=>{await lockAskLifecycle(context);await lockMonthlySpend(context);await settleAttempt(context,{reservationId:reserved.reservationId,at:await now(context),outcome:unknown?{kind:'estimated'}:{kind:'settled',cents:outcome.acceptance==='not_accepted'?0:cost!}});await context.db.query("UPDATE crm_ask_financial_receipts SET dispatch_state=$3 WHERE workspace_id=$1 AND id=$2 AND dispatch_state='calling'",[context.scope.workspaceId,reserved.id,unknown?'unknown_acceptance':'settled']);});
  if(unknown||outcome.acceptance!=='accepted'||!usage.success||usage.data.inputTokens>bytes)return null;
  const vector=z.array(z.number().finite()).length(adapter!.dimensions).safeParse(outcome.vector);if(!vector.success||vector.data.every(value=>value===0))return null;
  const finalProof=await verifyAskPurpose(runtime,stageProof);const current=await readCurrentAskInput(context,requestId,version,epoch,initial.proofInput.route);if(!current||current.inputHash!==initial.inputHash||!finalProof||Date.parse(finalProof.validUntil)<=Date.parse(await now(context)))return null;
  return vector.data;
 }
 return {embed,unknown:()=>anyUnknown,purpose,route,adapter,proofInput};
}

async function rankAskHistoryHybrid(input:JobHandlerInput,runtime:AskAnswerComposition,snapshot:NonNullable<Awaited<ReturnType<typeof readCurrentAskInput>>>,history:Omit<NonNullable<Awaited<ReturnType<typeof searchAskHistory>>>,'retrieval'|'semantic'> & {retrieval:'ranked_lexical'|'hybrid_rrf';semantic:'unavailable'|'unverified'},query:string,limit:number,deadlineAt:number){
 if(askLexicalConfiguration(query)==='simple')return {unknown:false,history};
 const meter=await createAskEmbeddingMeter(input,runtime,snapshot,deadlineAt);if(!meter)return {unknown:false,history};
 const vector=await meter.embed(query,'embedding_query');if(!vector)return {unknown:meter.unknown(),history};
 const located=await locate(input);if(!located)return {unknown:false,history};
 const semantic=await searchCanonicalIndex(located.context,{eligibleSources:history.eligibleSources,queryVector:vector,purpose:meter.purpose,route:meter.route,limit});
 if(semantic.coverage.state==='unavailable')return {unknown:false,history};
 const id=(source:CanonicalSourceReference,locator:string)=>`${source.kind}:${source.sourceId}:${locator}`;
 const matches=new Map<string,{source:CanonicalSourceReference;locator:string;score:number}>();for(const ranking of [history.matches,semantic.windows])for(const [rank,match]of ranking.entries()){const key=id(match.source,match.locator),prior=matches.get(key);matches.set(key,{source:match.source,locator:match.locator,score:(prior?.score??0)+1/(60+rank+1)});}
 const selected=[...matches.values()].sort((a,b)=>b.score-a.score||id(a.source,a.locator).localeCompare(id(b.source,b.locator))).slice(0,limit);
 return {unknown:false,history:{...history,matches:selected,sources:[...new Map(selected.map(match=>[`${match.source.kind}:${match.source.sourceId}`,match.source])).values()],retrieval:'hybrid_rrf' as const,semantic:'unverified' as const,partial:history.partial||semantic.coverage.state!=='complete'}};
}
