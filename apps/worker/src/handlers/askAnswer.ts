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
import {readAsk} from '@fss/domain/crm/ask.ts';
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

const agentCandidate=z.strictObject({claims:z.array(z.strictObject({text:z.string().min(1).max(1000),kind:z.enum(['fact','inference','conflict']),citationWindowIds:z.array(z.uuid()).min(1).max(10)})).max(20),abstained:z.boolean()}).refine(value=>!value.abstained||value.claims.length===0);
const toolCall=z.strictObject({id:z.string().min(1).max(100),name:z.enum(['read_exact','read_selected','search_selected']),input:z.unknown()});
async function handleAskAgent(input:JobHandlerInput,runtime:AskAnswerComposition,located:NonNullable<Awaited<ReturnType<typeof locate>>>){
 const {context,requestId,version,epoch}=located,agent=runtime.agent,limits=runtime.agentLimits;
 const update=async(state:string,reason:string|null)=>withTransaction(input.session,async()=>{await lockAskLifecycle(context);if(await fenced(input))await setState(context,requestId,version,epoch,state,reason);});
 if(!agent||!limits||!Number.isInteger(limits.maxSteps)||limits.maxSteps<1||limits.maxSteps>32||!Number.isInteger(limits.maxInputBytes)||limits.maxInputBytes<1||limits.maxInputBytes>1000000||!Number.isInteger(limits.maxOutputTokens)||limits.maxOutputTokens<1||limits.maxOutputTokens>4096||!Number.isInteger(limits.deadlineMs)||limits.deadlineMs<1||limits.deadlineMs>60000){await update('unavailable','processing_authority_unavailable');return;}
 const originalRun=agent.runStep;const route={endpointId:agent.endpointId,modelVersion:agent.modelVersion,providerKey:agent.providerKey},run=originalRun.bind(Object.freeze({...agent})),started=Date.now();
 const unchanged=()=>runtime.agent===agent&&agent.endpointId===route.endpointId&&agent.modelVersion===route.modelVersion&&agent.providerKey===route.providerKey&&agent.runStep===originalRun;
 const current=async()=>withTransaction(input.session,async()=>{await lockAskLifecycle(context);if(!await fenced(input))return null;const row=(await context.db.query<{cancelled_at:Date|null}>('SELECT cancelled_at FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,requestId])).rows[0];if(row?.cancelled_at)return null;return readCurrentAskInput(context,requestId,version,epoch,route);});
 const initial=await current();if(!initial)return;if(initial.identityAmbiguous){await update('unavailable','identity_clarification_required');return;}
 const transcript:unknown[]=[...initial.history,{windows:initial.windows.map(window=>({id:window.id,ordinal:window.ordinal,source:window.source,text:window.text})),coverage:initial.coverage}];
 let retrievalSummary:unknown;
 const exactResults:{toolCallId:string;operation:'opportunities'|'tasks'|'reply_status';valueHash:string;value:unknown}[]=[];
 for(let step=1;step<=limits.maxSteps;step++){
  const snapshot=await current();if(!snapshot||snapshot.inputHash!==initial.inputHash){await update('stale','source_changed');return;}
  const proof=await verifyAskPurpose(runtime,snapshot.proofInput);if(!proof||!unchanged()||proof.evaluationKind==='actual'&&(askFingerprint(snapshot.proofInput.purpose.agentLimits??null)!==askFingerprint(limits)||Object.entries(CRM_SUPPORTED_AGENT_ASK_VERSIONS).some(([key,value])=>snapshot.proofInput.purpose[key as keyof typeof CRM_SUPPORTED_AGENT_ASK_VERSIONS]!==value))){await update('unavailable','processing_authority_unavailable');return;}
  const inputTokens=Buffer.byteLength(JSON.stringify({question:snapshot.question,transcript}))+2048;
  if(inputTokens>limits.maxInputBytes||Date.now()-started>=limits.deadlineMs){await update('unavailable','input_bound_reached');return;}
  const reserved=await withTransaction(input.session,async()=>{await lockAskLifecycle(context);
   const live=await readCurrentAskInput(context,requestId,version,epoch,route);if(!live||live.inputHash!==initial.inputHash||!await fenced(input))return null;
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
   const receipt=(await context.db.query<{id:string}>(`INSERT INTO crm_ask_financial_receipts(workspace_id,request_id,request_version,request_epoch,stage,attempt,reservation_id,job_id,fencing_token,purpose_revision,purpose_snapshot,config_fingerprint,evaluation_fingerprint,authorization_fingerprint,input_hash,input_price_micros,output_price_micros,max_input_tokens,max_output_tokens,dispatch_state) VALUES($1,$2,$3,$4,'answer',$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,'reserved') RETURNING id`,[context.scope.workspaceId,requestId,version,epoch,step,reservation.id,input.job.id,input.job.fencingToken,purpose.revision,JSON.stringify(purpose),live.proofInput.configFingerprint,purpose.evaluationFingerprint,live.proofInput.authorizationFingerprint,live.inputHash,purpose.inputTokenPriceMicros,purpose.outputTokenPriceMicros,inputTokens,limits.maxOutputTokens])).rows[0]!;
   if(!await markCalling(context,reservation.id))return null;
   await context.db.query("UPDATE crm_ask_financial_receipts SET dispatch_state='calling' WHERE workspace_id=$1 AND id=$2",[context.scope.workspaceId,receipt.id]);
   await context.db.query("UPDATE crm_ask_requests SET progress_stage='calling' WHERE workspace_id=$1 AND id=$2 AND state='pending'",[context.scope.workspaceId,requestId]);
   return {id:receipt.id,reservationId:reservation.id,purpose};
  });if(!reserved)return;
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<Awaited<ReturnType<typeof run>>>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({acceptance:'unknown',usage:null,answer:null,toolCalls:[]});},Math.max(1,limits.deadlineMs-(Date.now()-started)));});
  let outcome:Awaited<ReturnType<typeof run>>;try{outcome=structuredClone(await Promise.race([run({question:snapshot.question,transcript:structuredClone(transcript),maxOutputTokens:limits.maxOutputTokens,signal:controller.signal}),timeout]));}catch{outcome={acceptance:'unknown',usage:null,answer:null,toolCalls:[]};}finally{if(timer)clearTimeout(timer);}
  const usage=z.strictObject({inputTokens:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),outputTokens:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).safeParse(outcome.usage),cost=usage.success?crmTokenCostCents(usage.data.inputTokens,usage.data.outputTokens,reserved.purpose.inputTokenPriceMicros,reserved.purpose.outputTokenPriceMicros):null;
  const unknown=outcome.acceptance==='unknown'||!usage.success||cost===null||!Number.isSafeInteger(cost)||cost>2147483647;
  await withTransaction(input.session,async()=>{await lockAskLifecycle(context);await lockMonthlySpend(context);await settleAttempt(context,{reservationId:reserved.reservationId,at:await now(context),outcome:unknown?{kind:'estimated'}:{kind:'settled',cents:outcome.acceptance==='not_accepted'?0:cost!}});await context.db.query("UPDATE crm_ask_financial_receipts SET dispatch_state=$3 WHERE workspace_id=$1 AND id=$2 AND dispatch_state='calling'",[context.scope.workspaceId,reserved.id,unknown?'unknown_acceptance':'settled']);if(await fenced(input))await context.db.query("UPDATE crm_ask_requests SET completed_steps=$3,progress_stage='validating' WHERE workspace_id=$1 AND id=$2 AND state='pending'",[context.scope.workspaceId,requestId,step]);});
  if(unknown){await update('unknown_acceptance','provider_acceptance_unknown');return;}
  if(outcome.acceptance!=='accepted'||!usage.success||usage.data.inputTokens>inputTokens||usage.data.outputTokens>limits.maxOutputTokens){await update('unavailable','processing_failed');return;}
  const live=await current(),liveProof=await verifyAskPurpose(runtime,snapshot.proofInput);if(!live||live.inputHash!==initial.inputHash||!liveProof||!unchanged()){await update('stale','source_changed');return;}
  const calls=z.array(toolCall).max(8).safeParse(outcome.toolCalls);if(!calls.success||new Set(calls.data.map(call=>call.id)).size!==calls.data.length){await update('unavailable','processing_failed');return;}
  if(calls.data.length){
   for(const call of calls.data){let value:unknown;
    if(call.name==='read_selected'){const args=z.strictObject({windowIds:z.array(z.uuid()).min(1).max(20)}).safeParse(call.input);if(!args.success||args.data.windowIds.some(id=>!live.windows.some(window=>window.id===id))){await update('unavailable','unsupported_answer');return;}value=live.windows.filter(window=>args.data.windowIds.includes(window.id));}
    else if(call.name==='search_selected'){const args=z.strictObject({query:z.string().trim().min(1).max(300),limit:z.number().int().min(1).max(20)}).safeParse(call.input);if(!args.success){await update('unavailable','unsupported_answer');return;}const ranked=await rankAskAgentHybrid(input,runtime,live,args.data.query,args.data.limit,started+limits.deadlineMs);if(ranked.unknown){await update('unknown_acceptance','provider_acceptance_unknown');return;}value=ranked.value;if(ranked.value&&'retrieval' in ranked.value){const {windows:_,retrieval,...summary}=ranked.value;void _;retrievalSummary={method:retrieval,...summary};}}
    else{if(exactResults.length>=20){await update('unavailable','input_bound_reached');return;}const args=z.strictObject({operation:z.enum(['opportunities','tasks','reply_status']),firmId:z.uuid()}).safeParse(call.input);const closure=(await context.db.query<{initial_access_closure:{firmIds:string[]}}>('SELECT initial_access_closure FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,requestId])).rows[0]?.initial_access_closure;if(!args.success||(!closure?.firmIds.includes(args.data.firmId)||!live.toolFirmIds.includes(args.data.firmId))){await update('unavailable','unsupported_answer');return;}value=await readAsk(context,args.data.operation==='opportunities'?{operation:'opportunities',scope:{firmId:args.data.firmId},limit:20,status:'all'}:args.data.operation==='tasks'?{operation:'tasks',scope:{firmId:args.data.firmId},limit:20}:{operation:'reply_status',scope:{firmId:args.data.firmId}});if(value===null){await update('unavailable','source_unavailable');return;}exactResults.push({toolCallId:call.id,operation:args.data.operation,valueHash:askFingerprint(value),value});if(Buffer.byteLength(JSON.stringify({exactResults}))>60000){await update('unavailable','input_bound_reached');return;}await withTransaction(input.session,async()=>{await lockAskLifecycle(context);const current=await readCurrentAskInput(context,requestId,version,epoch,route);if(!current||current.inputHash!==initial.inputHash||!await fenced(input))return;await context.db.query("UPDATE crm_ask_requests SET validated_progress=$5::jsonb WHERE workspace_id=$1 AND id=$2 AND version=$3 AND epoch=$4 AND state='pending' AND cancelled_at IS NULL",[context.scope.workspaceId,requestId,version,epoch,JSON.stringify({exactResults})]);});}
    transcript.push({toolCallId:call.id,name:call.name,input:call.input,result:value});
   }continue;
  }
  const candidate=agentCandidate.safeParse(outcome.answer);if(!candidate.success||candidate.data.claims.some(claim=>new Set(claim.citationWindowIds).size!==claim.citationWindowIds.length||claim.citationWindowIds.some(id=>!live.windows.some(window=>window.id===id)))){await update('unavailable','unsupported_answer');return;}
  await withTransaction(input.session,async()=>{await lockAskLifecycle(context);const final=await readCurrentAskInput(context,requestId,version,epoch,route);let authority=false;try{authority=runtime.revalidatePurpose?await runtime.revalidatePurpose(context,snapshot.proofInput):runtime.allowControlledEvaluation===true;}catch{/* Closed. */}if(!authority||!final||final.inputHash!==initial.inputHash||!await fenced(input))return;
   const cancellation=(await context.db.query<{cancelled_at:Date|null}>('SELECT cancelled_at FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,requestId])).rows[0];if(cancellation?.cancelled_at)return;
   for(const exact of exactResults){const value=exact.value as {scope:{firmId:string}};const refreshed=await readAsk(context,exact.operation==='opportunities'?{operation:'opportunities',scope:value.scope,limit:20,status:'all'}:exact.operation==='tasks'?{operation:'tasks',scope:value.scope,limit:20}:{operation:'reply_status',scope:value.scope});if(refreshed===null||askFingerprint(refreshed)!==exact.valueHash){await setState(context,requestId,version,epoch,'stale','source_changed');return;}}
   const result=askGroundedAnswerSchema.parse({resultVersion:'agent_v1',...retrievalSummary?{retrieval:retrievalSummary}:{},exactResults,answeredAt:await now(context),claims:candidate.data.claims.map(claim=>({...claim,verification:'cited_unverified'})),conflicts:final.conflicts,missingEvidence:[...final.conflicts.length?['conflict_unresolved']:[],...candidate.data.claims.some(claim=>claim.kind==='inference')?['inference_unverified']:[],...final.retrievalPartial?['input_partial']:[]],abstained:candidate.data.abstained,coverage:{acquisition:'unverified',semantic:'unverified',input:final.retrievalPartial?'partial':'complete',sourceCeiling:10,windowCeiling:1000,groupCeiling:10,evaluationFingerprint:reserved.purpose.evaluationFingerprint}});
   await context.db.query("UPDATE crm_ask_requests SET state='complete',reason=NULL,result=$5::jsonb,result_at=clock_timestamp(),progress_stage='complete',updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND version=$3 AND epoch=$4 AND state='pending'",[context.scope.workspaceId,requestId,version,epoch,JSON.stringify(result)]);
  });return;
 }await update('unavailable','input_bound_reached');
}

/** Small exact-array cosine prototype, versioned per immutable canonical window. No extension prerequisite. */
async function rankAskAgentHybrid(input:JobHandlerInput,runtime:AskAnswerComposition,initial:NonNullable<Awaited<ReturnType<typeof readCurrentAskInput>>>,query:string,limit:number,deadlineAt:number){
 const located=await locate(input);if(!located)return {unknown:false,value:{windows:[],retrieval:'unavailable'}};
 const {context,requestId,version,epoch}=located;
 const lexical=(await context.db.query<{id:string}>(`SELECT id FROM unnest($1::uuid[],$2::text[]) AS windows(id,text) WHERE to_tsvector('simple',text) @@ websearch_to_tsquery('simple',$3) ORDER BY ts_rank_cd(to_tsvector('simple',text),websearch_to_tsquery('simple',$3)) DESC,id LIMIT $4`,[initial.windows.map(window=>window.id),initial.windows.map(window=>window.text),query,limit])).rows.map(row=>row.id);
 const fallback=()=>({unknown:false,value:{windows:lexical.map(id=>initial.windows.find(window=>window.id===id)!),retrieval:'ranked_lexical',semantic:'unavailable',partial:true}});
 const configuredAdapter=runtime.embedding;if(!configuredAdapter||initial.windows.length===0)return fallback();const adapter=configuredAdapter;
 const route={endpointId:adapter.endpointId,modelVersion:adapter.modelVersion,providerKey:adapter.providerKey};
 const configuredPurpose=await readAskPurpose(context,'embedding');if(!configuredPurpose||configuredPurpose.endpointId!==route.endpointId||configuredPurpose.modelVersion!==route.modelVersion)return fallback();const purpose=configuredPurpose;
 const originalEmbed=adapter.embed,invoke=originalEmbed.bind(Object.freeze({...adapter}));
 const proofInput={...initial.proofInput,stage:'embedding_query' as const,purpose,route,configFingerprint:askFingerprint({purpose,route})};
 const proof=await verifyAskPurpose(runtime,proofInput);if(!proof||proof.evaluationKind==='actual'&&purpose.embeddingDimensions!==adapter.dimensions)return fallback();
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
 const queryVector=await embed(query,'embedding_query');if(!queryVector)return anyUnknown?{unknown:true,value:null}:fallback();
 const candidates=initial.windows.slice(0,20);let indexed=0;
 for(const window of candidates){
  let stored=(await context.db.query<{vector:number[]}>('SELECT vector FROM crm_ask_window_vectors WHERE workspace_id=$1 AND window_id=$2 AND purpose_revision=$3 AND model_version=$4 AND input_hash=$5 AND config_fingerprint=$6 AND dimensions=$7',[context.scope.workspaceId,window.id,purpose.revision,route.modelVersion,window.textHash,proofInput.configFingerprint,adapter.dimensions])).rows[0];
  if(!stored){const vector=await embed(window.text,'embedding_document');if(anyUnknown)return {unknown:true,value:null};if(!vector)continue;
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
