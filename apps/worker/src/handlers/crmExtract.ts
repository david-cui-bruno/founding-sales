import {flagPublishedCrmEvidence} from '@fss/domain/crm/evidenceDecisions.ts';
import {unavailableMailEvidence,type CrmMailEvidencePort,type MailProcessingAuthority} from '@fss/domain/crm/mailEvidence.ts';
import {createHash} from 'node:crypto';
import {readProcessingContext,parsedProcessingContext,sameProcessingContext,processingContextHash,NATIVE_PROCESSING_AUTHORIZATION_HASH,UNAVAILABLE_MAIL_AUTHORIZATION_HASH} from '@fss/domain/crm/processingContext.ts';
import { z } from 'zod';
import type { JobHandler, JobHandlerInput } from '@fss/domain/jobs/handlerRegistry.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '@fss/domain/db/workspaceScope.ts';
import { resolveCrmSource, loadCrmExtractionText, type SourceLookup } from '@fss/domain/crm/sourceResolver.ts';
import type { Generation } from '@fss/domain/crm/processing.ts';
import { reserveAttempt, markCalling, settleAttempt } from '@fss/domain/research/reservations.ts';
import { providerFunding } from '@fss/domain/settings/funding.ts';
import { lockMonthlySpend } from '@fss/domain/research/ledger.ts';
import { clearMonthlyCash, monthWithinCeiling } from '@fss/domain/settings/cashCeiling.ts';
import { workspaceBusinessZone } from '@fss/domain/research/ledger.ts';
import { localDate } from '@fss/domain/src/rules/localClock.ts';
const claimsSchema=z.array(z.strictObject({kind:z.enum(['need','objection','commitment']),interpretation:z.string().min(1).max(1000),status:z.enum(['stated','inferred']),locator:z.string().min(1).max(200),quote:z.string().min(1).max(2000)})).max(50);
export interface CrmExtractionAdapter {
 endpointId:string;modelVersion:string;accessGrantVersion:string;dataHandlingVersion:string;providerKey:string;fundingVerifiedUntil:string;
 run(input:{source:SourceLookup;text:string;maxOutputTokens:number;signal?:AbortSignal}):Promise<{acceptance:'accepted'|'unknown'|'not_accepted';usage:{inputTokens:number;outputTokens:number}|null;claims:unknown}>;
}
export interface CrmExtractOptions {mailEvidence?:CrmMailEvidencePort;adapter?:CrmExtractionAdapter;providerTimeoutMs?:number}
interface Purpose { [key:string]:unknown;revision:number;enabled:boolean;endpoint_id:string;model_version:string;access_grant_version:string;data_handling_version:string;daily_ceiling_cents:number;monthly_ceiling_cents:number;input_token_price_micros:number;output_token_price_micros:number }
interface Receipt { [key:string]:unknown;reservation_id:string;dispatch_state:string;job_id:string;fencing_token:string;endpoint_id:string;model_version:string;access_grant_version:string;data_handling_version:string;purpose_revision:number;input_price_micros:number;output_price_micros:number }
async function locate(input:JobHandlerInput){
 const id=input.job.payload['generationId'];if(typeof id!=='string')return null;
 const row=(await input.session.query<Generation>('SELECT * FROM crm_extraction_generations WHERE workspace_id=$1 AND id=$2',[input.scope.workspaceId,id])).rows[0];if(row===undefined)return null;
 const actor=(await input.session.query<{role:'admin'|'salesperson';status:string}>('SELECT role,status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',[input.scope.workspaceId,row.requested_by])).rows[0];
 if(actor?.status!=='active')return null;
 return {row,context:repositoryContext(workspaceScope(input.scope.workspaceId,{kind:'user',userId:row.requested_by,role:actor.role}),input.session),source:{workspaceId:input.scope.workspaceId,sourceId:row.source_id,kind:row.source_kind,revision:row.source_revision,contentHash:row.source_hash,locator:null} satisfies SourceLookup};
}
async function fenced(input:JobHandlerInput){return (await input.session.query(`SELECT id FROM jobs WHERE workspace_id=$1 AND id=$2 AND state='running' AND lease_owner=$3 AND fencing_token=$4::bigint AND lease_expires_at>clock_timestamp() FOR UPDATE`,[input.scope.workspaceId,input.job.id,input.job.leaseOwner,input.job.fencingToken])).rows.length===1;}
async function databaseNow(context:RepositoryContext){const value=(await context.db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]?.at;if(value===undefined)throw new Error('database_clock_unavailable');return value.toISOString();}
async function purpose(context:RepositoryContext,row:Generation,adapter:CrmExtractionAdapter|undefined){
 const p=(await context.db.query<Purpose>('SELECT * FROM crm_extraction_purposes WHERE workspace_id=$1 FOR SHARE',[context.scope.workspaceId])).rows[0];
 const matches=p!==undefined&&p.enabled&&adapter!==undefined&&p.revision===row.purpose_revision&&p.model_version===row.model_version&&p.endpoint_id===adapter.endpointId&&p.model_version===adapter.modelVersion&&p.access_grant_version===adapter.accessGrantVersion&&p.data_handling_version===adapter.dataHandlingVersion&&p.daily_ceiling_cents>0&&p.monthly_ceiling_cents>0&&Date.parse(adapter.fundingVerifiedUntil)>Date.parse(await databaseNow(context));
 return matches?p:null;
}
function samePurposeSnapshot(p:Purpose,r:Receipt){return p.revision===r.purpose_revision&&p.endpoint_id===r.endpoint_id&&p.model_version===r.model_version&&p.access_grant_version===r.access_grant_version&&p.data_handling_version===r.data_handling_version&&p.input_token_price_micros===r.input_price_micros&&p.output_token_price_micros===r.output_price_micros;}
async function receipt(context:RepositoryContext,id:string){return (await context.db.query<Receipt>('SELECT * FROM crm_extraction_financial_receipts WHERE workspace_id=$1 AND generation_id=$2',[context.scope.workspaceId,id])).rows[0];}
async function setState(context:RepositoryContext,id:string,state:string,reason:string|null){await context.db.query("UPDATE crm_extraction_generations SET state=$3,reason=$4 WHERE workspace_id=$1 AND id=$2 AND state NOT IN ('deleted','stale')",[context.scope.workspaceId,id,state,reason]);}
async function centsWithin(context:RepositoryContext,p:Purpose,at:string,zone:string,extra:number,providerKey:string){
 await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${context.scope.workspaceId}:crm-extraction-budget`]);
 await lockMonthlySpend(context);
 const day=localDate(at,zone);
 const totals=(await context.db.query<{daily:string;monthly:string}>(`SELECT COALESCE(sum(CASE WHEN state IN ('reserved','calling') THEN cents ELSE settled_cents END) FILTER(WHERE business_date=$2::date),0)::text daily,COALESCE(sum(CASE WHEN state IN ('reserved','calling') THEN cents ELSE settled_cents END) FILTER(WHERE date_trunc('month',business_date)=date_trunc('month',$2::date)),0)::text monthly FROM provider_reservations WHERE workspace_id=$1 AND subject_kind='crm_extraction'`,[context.scope.workspaceId,day])).rows[0];
 return Number(totals?.daily??0)+extra<=p.daily_ceiling_cents&&Number(totals?.monthly??0)+extra<=p.monthly_ceiling_cents&& (providerFunding(providerKey)==='credits'||(extra===0?await monthWithinCeiling(context,{at,zone}):await clearMonthlyCash(context,{at,zone,cents:extra})));
}
/** A reclaimed dispatch is financial recovery, never permission to repeat the call. */
async function recoverDispatched(input:JobHandlerInput):Promise<boolean>{
 const generationId=input.job.payload['generationId'];if(typeof generationId!=='string')return false;
 const context=repositoryContext(input.scope,input.session);
 await context.db.query('SELECT id FROM crm_extraction_generations WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[input.scope.workspaceId,generationId]);
 if(!await fenced(input))return true;
 const previous=await receipt(context,generationId);
 if(previous?.dispatch_state!=='calling'||previous.fencing_token===input.job.fencingToken&&previous.job_id===input.job.id)return false;
 await lockMonthlySpend(context);
 await settleAttempt(context,{reservationId:previous.reservation_id,at:await databaseNow(context),outcome:{kind:'estimated'}});
 await context.db.query("UPDATE crm_extraction_financial_receipts SET dispatch_state='unknown_acceptance' WHERE workspace_id=$1 AND generation_id=$2 AND dispatch_state='calling'",[input.scope.workspaceId,generationId]);
 await setState(context,generationId,'unknown_acceptance','provider_acceptance_unknown');
 return true;
}
/** The external wait is outside every database transaction. Dispatch is a durable at-most-once marker. */
export function crmExtractJobHandler(options:CrmExtractOptions):JobHandler{
 const mailEvidence=options.mailEvidence??unavailableMailEvidence;
 async function verifyMail(input:JobHandlerInput):Promise<MailProcessingAuthority|null>{
  try{const located=await locate(input);if(located===null||located.source.kind!=='mail')return null;
  const verified=await mailEvidence.authorizeProcessing(located.context,located.source,located.row.requested_by);
  return verified?.authorizationFingerprint===located.row.authorization_hash?verified:null;}catch{return null;}
 }
 return {kind:'crm.extract',protection:'outbound_fence',maxAttempts:3,leaseSeconds:120,async handle(input){
  if(await withTransaction(input.session,()=>recoverDispatched(input)))return;
  const reserveAuthority=await verifyMail(input);
  const reserved=await withTransaction(input.session,async()=>{
   const located=await locate(input);if(located===null)return null;
   const {row,context,source}=located;
   const mailAuthority=source.kind==='mail'&&reserveAuthority!==null&&await mailEvidence.revalidatePrepared(context,reserveAuthority)?reserveAuthority:null;
   const authorizationHash=source.kind==='mail'?mailAuthority?.authorizationFingerprint:NATIVE_PROCESSING_AUTHORIZATION_HASH;
   const resolved=await resolveCrmSource(context,source,mailEvidence);if(resolved===null)return null;
   await context.db.query('SELECT id FROM crm_extraction_generations WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[context.scope.workspaceId,row.id]);
   if(!await fenced(input))return null;
   if(source.kind==='mail'&&mailAuthority===null){await setState(context,row.id,row.authorization_hash===UNAVAILABLE_MAIL_AUTHORIZATION_HASH?'unavailable':'stale',row.authorization_hash===UNAVAILABLE_MAIL_AUTHORIZATION_HASH?'mail_processing_authority_unavailable':'source_or_authority_changed');return null;}
   const currentContext=await readProcessingContext(context,source,mailEvidence);if(currentContext===null)return null;if(row.authorization_hash!==authorizationHash||processingContextHash(currentContext)!==row.context_hash){await setState(context,row.id,'stale','source_context_changed');return null;}
   const capturedContext=parsedProcessingContext(row.context_snapshot);if(capturedContext!==null&&!sameProcessingContext(capturedContext,currentContext)){await setState(context,row.id,'stale','source_context_changed');return null;}
   if(capturedContext===null){await context.db.query('UPDATE crm_extraction_generations SET context_snapshot=$3::jsonb WHERE workspace_id=$1 AND id=$2 AND context_snapshot IS NULL',[context.scope.workspaceId,row.id,JSON.stringify(currentContext)]);row.context_snapshot=currentContext;}
   const previous=await receipt(context,row.id);if(previous!==undefined)return previous.dispatch_state==='reserved'?{...located,reservationId:previous.reservation_id}:null;
   const blockers=await context.db.query(`SELECT 1 FROM crm_extraction_financial_receipts f JOIN crm_extraction_generations g ON g.workspace_id=f.workspace_id AND g.id=f.generation_id WHERE g.workspace_id=$1 AND g.source_id=$2 AND g.source_kind=$3 AND f.dispatch_state IN ('calling','unknown_acceptance') LIMIT 1`,[context.scope.workspaceId,source.sourceId,source.kind]);
   if(blockers.rows.length){await setState(context,row.id,'unknown_acceptance','prior_acceptance_unknown');return null;}
   const p=await purpose(context,row,options.adapter);if(p===null||options.adapter===undefined){await setState(context,row.id,'unavailable','purpose_authority_unavailable');return null;}
   const text=(source.kind==='mail'?(mailAuthority===null?null:await mailEvidence.loadOriginalInput(context,mailAuthority)):await loadCrmExtractionText(context,source));
   if(text===null||text===undefined||Buffer.byteLength(text)>80000){await setState(context,row.id,'unavailable','input_unavailable');return null;}
   const inputTokens=Buffer.byteLength(text)+1024,maxOutputTokens=4096;
   // Prices are microdollars per token; each attempt rounds up to whole cents.
   const cents=Math.ceil((inputTokens*p.input_token_price_micros+maxOutputTokens*p.output_token_price_micros)/10000);
   const at=await databaseNow(context),zone=await workspaceBusinessZone(context);
   if(!await centsWithin(context,p,at,zone,cents,options.adapter.providerKey)){await setState(context,row.id,'unavailable','budget_held');return null;}
   const attempt=await reserveAttempt(context,{providerKey:options.adapter.providerKey,subjectKind:'crm_extraction',subjectId:row.id,attempt:1,at,businessTimeZone:zone,cents,modelName:p.model_version,maxInputTokens:inputTokens,maxOutputTokens});
   await context.db.query(`INSERT INTO crm_extraction_financial_receipts(workspace_id,generation_id,reservation_id,job_id,fencing_token,dispatch_state,endpoint_id,model_version,access_grant_version,data_handling_version,purpose_revision,input_price_micros,output_price_micros) VALUES($1,$2,$3,$4,$5,'reserved',$6,$7,$8,$9,$10,$11,$12)`,[context.scope.workspaceId,row.id,attempt.id,input.job.id,input.job.fencingToken,p.endpoint_id,p.model_version,p.access_grant_version,p.data_handling_version,p.revision,p.input_token_price_micros,p.output_token_price_micros]);
   await setState(context,row.id,'pending',null);return {...located,reservationId:attempt.id};
  });
  if(reserved===null)return;
  const dispatchAuthority=await verifyMail(input);
  const dispatch=await withTransaction(input.session,async()=>{
   const {context,source,row,reservationId}=reserved;
   const mailAuthority=source.kind==='mail'&&dispatchAuthority!==null&&await mailEvidence.revalidatePrepared(context,dispatchAuthority)?dispatchAuthority:null;
   const authorizationHash=source.kind==='mail'?mailAuthority?.authorizationFingerprint:NATIVE_PROCESSING_AUTHORIZATION_HASH;
   const resolved=await resolveCrmSource(context,source,mailEvidence);
   await context.db.query('SELECT id FROM crm_extraction_generations WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[context.scope.workspaceId,row.id]);
   const p=await purpose(context,row,options.adapter),r=await receipt(context,row.id);
   const currentContext=resolved===null?null:await readProcessingContext(context,source,mailEvidence),capturedContext=parsedProcessingContext(row.context_snapshot);
   const at=await databaseNow(context),zone=await workspaceBusinessZone(context);
   const reservedShape=(await context.db.query<{business_date:string;business_time_zone:string;provider_key:string;model_name:string;max_input_tokens:number;max_output_tokens:number}>('SELECT business_date::text,business_time_zone,provider_key,model_name,max_input_tokens,max_output_tokens FROM provider_reservations WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,reservationId])).rows[0];
   if(resolved===null||currentContext===null||row.authorization_hash!==authorizationHash||processingContextHash(currentContext)!==row.context_hash||capturedContext===null||!sameProcessingContext(capturedContext,currentContext)||!await fenced(input)||p===null||r?.dispatch_state!=='reserved'||reservedShape===undefined||reservedShape.business_date!==localDate(at,zone)||reservedShape.business_time_zone!==zone||reservedShape.provider_key!==options.adapter?.providerKey||reservedShape.model_name!==p.model_version||!samePurposeSnapshot(p,r)||!await centsWithin(context,p,at,zone,0,options.adapter?.providerKey??'unavailable')){
    await lockMonthlySpend(context);await settleAttempt(context,{reservationId,at,outcome:{kind:'released'}});await context.db.query("UPDATE crm_extraction_financial_receipts SET dispatch_state='released' WHERE workspace_id=$1 AND generation_id=$2 AND dispatch_state='reserved'",[context.scope.workspaceId,row.id]);await setState(context,row.id,'unavailable','reservation_authority_changed');return null;
   }
   const text=(source.kind==='mail'?(mailAuthority===null?null:await mailEvidence.loadOriginalInput(context,mailAuthority)):await loadCrmExtractionText(context,source));
   if(text===undefined||text===null||!await markCalling(context,reservationId))return null;
   await context.db.query("UPDATE crm_extraction_financial_receipts SET dispatch_state='calling',job_id=$3,fencing_token=$4 WHERE workspace_id=$1 AND generation_id=$2 AND dispatch_state='reserved'",[context.scope.workspaceId,row.id,input.job.id,input.job.fencingToken]);
   await setState(context,row.id,'processing',null);return {text,p};
  });
  if(dispatch===null||options.adapter===undefined)return;
  let answer:Awaited<ReturnType<CrmExtractionAdapter['run']>>;
  const controller=new AbortController();
  let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<Awaited<ReturnType<CrmExtractionAdapter['run']>>>(resolve=>{
    timer=setTimeout(()=>{controller.abort();resolve({acceptance:'unknown',usage:null,claims:[]});},Math.max(1,Math.min(60000,options.providerTimeoutMs??60000)));
  });
  try{answer=await Promise.race([options.adapter.run({source:reserved.source,text:dispatch.text,maxOutputTokens:4096,signal:controller.signal}),timeout]);}catch{answer={acceptance:'unknown',usage:null,claims:[]};}finally{if(timer!==undefined)clearTimeout(timer);}
  const publicationAuthority=await verifyMail(input);
  await withTransaction(input.session,async()=>{
   const {context,source,row,reservationId}=reserved;
   const mailAuthority=source.kind==='mail'&&publicationAuthority!==null&&await mailEvidence.revalidatePrepared(context,publicationAuthority)?publicationAuthority:null;
   const authorizationHash=source.kind==='mail'?mailAuthority?.authorizationFingerprint:NATIVE_PROCESSING_AUTHORIZATION_HASH;
   const resolved=await resolveCrmSource(context,source,mailEvidence);
   await context.db.query('SELECT id FROM crm_extraction_generations WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[context.scope.workspaceId,row.id]);
   const p=await purpose(context,row,options.adapter),r=await receipt(context,row.id);
   const currentContext=resolved===null?null:await readProcessingContext(context,source,mailEvidence),capturedContext=parsedProcessingContext(row.context_snapshot);
   if(r?.dispatch_state!=='calling')return;
   const bounds=(await context.db.query<{max_input_tokens:number;max_output_tokens:number}>('SELECT max_input_tokens,max_output_tokens FROM provider_reservations WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,reservationId])).rows[0];
   const validUsage=answer.usage!==null&&Number.isSafeInteger(answer.usage.inputTokens)&&answer.usage.inputTokens>=0&&Number.isSafeInteger(answer.usage.outputTokens)&&answer.usage.outputTokens>=0;
   const charged=validUsage&&answer.usage!==null?Math.ceil((answer.usage.inputTokens*r.input_price_micros+answer.usage.outputTokens*r.output_price_micros)/10000):null;
   // Take this purpose's budget lock before the shared monthly money lock.
   if(p!==null)await centsWithin(context,p,await databaseNow(context),await workspaceBusinessZone(context),0,options.adapter?.providerKey??'unavailable');
   const representableCharge=charged!==null&&Number.isSafeInteger(charged)&&charged>=0&&charged<=2147483647?charged:null;
   await lockMonthlySpend(context);
   await settleAttempt(context,{reservationId,at:await databaseNow(context),outcome:answer.acceptance==='not_accepted'?{kind:'settled',cents:0}:answer.acceptance==='unknown'||representableCharge===null?{kind:'estimated'}:{kind:'settled',cents:representableCharge}});
   const unknown=answer.acceptance==='unknown';
   await context.db.query('UPDATE crm_extraction_financial_receipts SET dispatch_state=$3 WHERE workspace_id=$1 AND generation_id=$2',[context.scope.workspaceId,row.id,unknown?'unknown_acceptance':'settled']);
   if(unknown){await setState(context,row.id,'unknown_acceptance','provider_acceptance_unknown');return;}
   if(resolved===null||currentContext===null||row.authorization_hash!==authorizationHash||processingContextHash(currentContext)!==row.context_hash||capturedContext===null||!sameProcessingContext(capturedContext,currentContext)||p===null||!samePurposeSnapshot(p,r)||!await fenced(input)){await setState(context,row.id,'stale','source_or_authority_changed');return;}
   if(!await centsWithin(context,p,await databaseNow(context),await workspaceBusinessZone(context),0,options.adapter?.providerKey??'unavailable')){await setState(context,row.id,'failed','budget_authority_changed');return;}
   if(validUsage&&answer.usage!==null&&(bounds===undefined||answer.usage.inputTokens>bounds.max_input_tokens||answer.usage.outputTokens>bounds.max_output_tokens)){await setState(context,row.id,'failed','provider_usage_exceeded');return;}
   const claims=claimsSchema.safeParse(answer.claims);
   if(!claims.success||answer.acceptance!=='accepted'){await setState(context,row.id,'failed','invalid_extraction');return;}
   for(const claim of claims.data){const citation=await resolveCrmSource(context,{...source,locator:claim.locator},mailEvidence);if(citation?.passage?.text!==claim.quote){await setState(context,row.id,'failed','invalid_quote');return;}}
   for(const claim of claims.data)await context.db.query('INSERT INTO crm_extraction_claims(workspace_id,generation_id,kind,interpretation,status,locator,quote,claim_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[context.scope.workspaceId,row.id,claim.kind,claim.interpretation,claim.status,claim.locator,claim.quote,createHash('sha256').update(JSON.stringify({source,context:capturedContext,...claim})).digest('hex')]);
   await flagPublishedCrmEvidence(context,source,row.context_hash,claims.data);
   await setState(context,row.id,'complete',null);
  });
 }};
}
