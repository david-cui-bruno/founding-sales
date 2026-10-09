import {z} from 'zod';
import {askGroundedAnswerSchema} from '@fss/contracts';
import type {JobHandler,JobHandlerInput} from '@fss/domain/jobs/handlerRegistry.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {repositoryContext,workspaceScope,type RepositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {readCurrentAskInput} from '@fss/domain/crm/askAnswerInput.ts';
import {verifyAskPurpose} from '@fss/domain/crm/askAnswerAuthority.ts';
import type {AskAnswerComposition,AskAnswerAdapter,AskPurposeSnapshot} from '@fss/domain/crm/askAnswerPorts.ts';
import {reserveAttempt,markCalling,settleAttempt} from '@fss/domain/research/reservations.ts';
import {lockMonthlySpend,workspaceBusinessZone} from '@fss/domain/research/ledger.ts';
import {clearMonthlyCash,monthWithinCeiling} from '@fss/domain/settings/cashCeiling.ts';
import {providerFunding} from '@fss/domain/settings/funding.ts';
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
 const totals=(await context.db.query<{daily:string;monthly:string}>(`SELECT coalesce(sum(CASE WHEN state IN ('reserved','calling') THEN cents ELSE settled_cents END) FILTER(WHERE business_date=$2::date),0)::text daily,coalesce(sum(CASE WHEN state IN ('reserved','calling') THEN cents ELSE settled_cents END) FILTER(WHERE date_trunc('month',business_date)=date_trunc('month',$2::date)),0)::text monthly FROM provider_reservations WHERE workspace_id=$1 AND subject_kind='crm_ask_answer'`,[context.scope.workspaceId,date])).rows[0]!;
 return Number(totals.daily)+extra<=purpose.dailyCeilingCents&&Number(totals.monthly)+extra<=purpose.monthlyCeilingCents&&(providerFunding(providerKey)==='credits'||(extra===0?await monthWithinCeiling(context,{at,zone}):await clearMonthlyCash(context,{at,zone,cents:extra})));
}
/** Durable calling precedes the wait; original copies are reread after every external stage. */
export function askAnswerJobHandler(composition:AskAnswerComposition={}):JobHandler{
 return {kind:'crm.ask_answer',protection:'outbound_fence',maxAttempts:3,leaseSeconds:120,async handle(input){
  const located=await locate(input);if(located===null)return;
  const {context,requestId,version,epoch}=located;
  async function snapshot(){return withTransaction(input.session,async()=>{const current=await readCurrentAskInput(context,requestId,version,epoch);return current!==null&&await fenced(input)?current:null;});}
  const initial=await snapshot();if(initial===null)return;
  const adapter=composition.answer;
  const proof=await verifyAskPurpose(composition,initial.proofInput);
  if(adapter===undefined||proof===null||adapter.endpointId!==initial.proofInput.purpose.endpointId||adapter.modelVersion!==initial.proofInput.purpose.modelVersion){await withTransaction(input.session,async()=>{if(await fenced(input))await setState(context,requestId,version,epoch,'unavailable','processing_authority_unavailable');});return;}
  const reserved=await withTransaction(input.session,async()=>{
   const current=await readCurrentAskInput(context,requestId,version,epoch);if(current===null||!await fenced(input)||current.inputHash!==initial.inputHash||Date.parse(proof.validUntil)<=Date.parse(await now(context)))return null;
   const previous=(await context.db.query<{dispatch_state:string}>('SELECT dispatch_state FROM crm_ask_financial_receipts WHERE workspace_id=$1 AND request_id=$2 AND stage=\'answer\'',[context.scope.workspaceId,requestId])).rows[0];if(previous!==undefined)return null;
   const purpose=current.proofInput.purpose;
   const inputTokens=Buffer.byteLength(JSON.stringify({question:current.question,windows:current.windows,groups:current.groups}))+1024,maxOutputTokens=4096;
   const cents=Math.ceil((inputTokens*purpose.inputTokenPriceMicros+maxOutputTokens*purpose.outputTokenPriceMicros)/10000);
   if(inputTokens>1000000||!Number.isSafeInteger(cents)||cents>2147483647||!await withinBudget(context,purpose,adapter.providerKey,cents)){await setState(context,requestId,version,epoch,'unavailable','budget_held');return null;}
   const at=await now(context),zone=await workspaceBusinessZone(context);
   const reservation=await reserveAttempt(context,{providerKey:adapter.providerKey,subjectKind:'crm_ask_answer',subjectId:requestId,attempt:1,at,businessTimeZone:zone,cents,modelName:purpose.modelVersion,maxInputTokens:inputTokens,maxOutputTokens});
   const receipt=(await context.db.query<{id:string}>(`INSERT INTO crm_ask_financial_receipts(workspace_id,request_id,request_version,request_epoch,stage,attempt,reservation_id,job_id,fencing_token,purpose_revision,purpose_snapshot,config_fingerprint,evaluation_fingerprint,authorization_fingerprint,input_hash,input_price_micros,output_price_micros,max_input_tokens,max_output_tokens,dispatch_state) VALUES($1,$2,$3,$4,'answer',1,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,'reserved') RETURNING id`,[context.scope.workspaceId,requestId,version,epoch,reservation.id,input.job.id,input.job.fencingToken,purpose.revision,JSON.stringify(purpose),current.proofInput.configFingerprint,purpose.evaluationFingerprint,current.proofInput.authorizationFingerprint,current.inputHash,purpose.inputTokenPriceMicros,purpose.outputTokenPriceMicros,inputTokens,maxOutputTokens])).rows[0]!;
   return {receiptId:receipt.id,reservationId:reservation.id,inputTokens,maxOutputTokens,purpose,inputHash:current.inputHash};
  });
  if(reserved===null)return;
  const dispatchProof=await verifyAskPurpose(composition,initial.proofInput);
  const dispatch=await withTransaction(input.session,async()=>{
   const current=await readCurrentAskInput(context,requestId,version,epoch);
   if(current===null||dispatchProof===null||current.inputHash!==reserved.inputHash||!await fenced(input)||Date.parse(dispatchProof.validUntil)<=Date.parse(await now(context))||!await withinBudget(context,reserved.purpose,adapter.providerKey,0)){await settleAttempt(context,{reservationId:reserved.reservationId,at:await now(context),outcome:{kind:'released'}});await context.db.query("UPDATE crm_ask_financial_receipts SET dispatch_state='released' WHERE workspace_id=$1 AND id=$2 AND dispatch_state='reserved'",[context.scope.workspaceId,reserved.receiptId]);return null;}
   if(!await markCalling(context,reserved.reservationId))return null;
   await context.db.query("UPDATE crm_ask_financial_receipts SET dispatch_state='calling' WHERE workspace_id=$1 AND id=$2 AND dispatch_state='reserved'",[context.scope.workspaceId,reserved.receiptId]);
   return structuredClone(current);
  });
  if(dispatch===null)return;
  let outcome:Awaited<ReturnType<AskAnswerAdapter['run']>>;
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const timed=new Promise<Awaited<ReturnType<AskAnswerAdapter['run']>>>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({acceptance:'unknown',usage:null,answer:null});},Math.max(1,Math.min(60000,composition.providerTimeoutMs??60000)));});
  try{outcome=await Promise.race([adapter.run({question:dispatch.question,windows:structuredClone(dispatch.windows),groups:structuredClone(dispatch.groups),maxOutputTokens:reserved.maxOutputTokens,signal:controller.signal}),timed]);}catch{outcome={acceptance:'unknown',usage:null,answer:null};}finally{if(timer!==undefined)clearTimeout(timer);}
  const finalProof=await verifyAskPurpose(composition,initial.proofInput);
  await withTransaction(input.session,async()=>{
   const current=await readCurrentAskInput(context,requestId,version,epoch);
   // Money remains recoverable even when private history is deleted or the actor is revoked.
   await lockMonthlySpend(context);
   const usage=z.strictObject({inputTokens:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),outputTokens:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).safeParse(outcome.usage);
   const cents=usage.success?Math.ceil((usage.data.inputTokens*reserved.purpose.inputTokenPriceMicros+usage.data.outputTokens*reserved.purpose.outputTokenPriceMicros)/10000):null;
   const unknown=outcome.acceptance==='unknown'||!usage.success||cents===null||!Number.isSafeInteger(cents)||cents>2147483647;
   await settleAttempt(context,{reservationId:reserved.reservationId,at:await now(context),outcome:unknown?{kind:'estimated'}:{kind:'settled',cents:outcome.acceptance==='not_accepted'?0:cents!}});
   await context.db.query('UPDATE crm_ask_financial_receipts SET dispatch_state=$3 WHERE workspace_id=$1 AND id=$2 AND dispatch_state=\'calling\'',[context.scope.workspaceId,reserved.receiptId,unknown?'unknown_acceptance':'settled']);
   if(!await fenced(input))return;
   if(unknown){await setState(context,requestId,version,epoch,'unknown_acceptance','provider_acceptance_unknown');return;}
   if(current===null||finalProof===null||current.inputHash!==reserved.inputHash||Date.parse(finalProof.validUntil)<=Date.parse(await now(context))){await setState(context,requestId,version,epoch,'stale','source_changed');return;}
   const candidate=candidateSchema.safeParse(outcome.answer);
   if(outcome.acceptance!=='accepted'||!candidate.success||!usage.success||usage.data.inputTokens>reserved.inputTokens||usage.data.outputTokens>reserved.maxOutputTokens){await setState(context,requestId,version,epoch,'unavailable','processing_failed');return;}
   const permitted=new Map(current.windows.map(window=>[window.id,window]));
   for(const claim of candidate.data.claims){if(claim.kind!=='extractive'||new Set(claim.citationWindowIds).size!==claim.citationWindowIds.length||claim.citationWindowIds.some(id=>!permitted.get(id)?.text.includes(claim.text))){await setState(context,requestId,version,epoch,'unavailable','unsupported_answer');return;}}
   const result=askGroundedAnswerSchema.parse({answeredAt:await now(context),claims:candidate.data.claims.map(claim=>({...claim,verification:'supported'})),conflicts:[],missingEvidence:candidate.data.abstained?['no_supported_answer']:[],abstained:candidate.data.abstained,coverage:{acquisition:'unverified',semantic:finalProof.evaluationKind==='actual'?'bounded_evaluated':'unverified',input:'complete',sourceCeiling:10,windowCeiling:1000,groupCeiling:10,evaluationFingerprint:reserved.purpose.evaluationFingerprint}});
   await context.db.query("UPDATE crm_ask_requests SET state='complete',reason=NULL,result=$5::jsonb,result_at=clock_timestamp(),updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND version=$3 AND epoch=$4 AND state='pending'",[context.scope.workspaceId,requestId,version,epoch,JSON.stringify(result)]);
  });
 }};
}
