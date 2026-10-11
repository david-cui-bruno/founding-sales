import {resolveAskAgentScope} from './askAgentScope.ts';
import {recordCrmAuditEvent} from './audit.ts';
import type {z} from 'zod';
import type {askAnswerInvestigationPreviewSchema} from '@fss/contracts';
import {askAgentScopeSchema,askAnswerInvestigationPreviewResultSchema,askAnswerRequestSchema} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor} from './identityAccess.ts';
import {lockAskLifecycle} from './askAnswerLifecycle.ts';
import {readAskAnswer,requestAskAnswer} from './askAnswers.ts';
import {askFingerprint,readAskPurpose} from './askAnswerAuthority.ts';
import {crmTokenCostCents} from './pricing.ts';

export async function cancelAskAnswer(context:RepositoryContext,input:{requestId:string;expectedVersion:number}){
 const actor=context.scope.actor;if(actor.kind!=='user'||!await activeIdentityActor(context))return {ok:false as const,reason:'source_access_denied'};
 await lockAskLifecycle(context);
 const row=(await context.db.query<{version:number;state:string;cancelled_at:Date|null}>(`SELECT version,state,cancelled_at FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 FOR UPDATE`,[context.scope.workspaceId,input.requestId,actor.userId])).rows[0];
 if(!row)return {ok:false as const,reason:'request_unavailable'};
 if(row.version!==input.expectedVersion)return {ok:false as const,reason:'stale_request'};
 if(row.cancelled_at)return {ok:true as const,value:{requestId:input.requestId,version:row.version,outcome:'already_cancelled'}};
 if(row.state!=='pending')return {ok:false as const,reason:'request_not_running'};
 await context.db.query(`UPDATE crm_ask_requests SET cancelled_at=clock_timestamp(),progress_stage='cancelled',state='unavailable',reason='processing_cancelled',updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[context.scope.workspaceId,input.requestId]);
 return {ok:true as const,value:{requestId:input.requestId,version:row.version,outcome:'cancelled'}};
}

type PreviewInput=z.infer<typeof askAnswerInvestigationPreviewSchema>;
/** This is a dated configured ceiling, never a purpose grant or a claim of available funds. */
export async function previewAskInvestigation(context:RepositoryContext,input:PreviewInput){
 const unavailable=(reason:string)=>askAnswerInvestigationPreviewResultSchema.parse({available:false,reason,previewHash:null,scope:null,question:null,additionalAllowance:null});
 const actor=context.scope.actor;if(actor.kind!=='user')return unavailable('source_access_denied');
 await lockAskLifecycle(context);
 const current=await readAskAnswer(context,input.requestId);
 if(!current||current.version!==input.expectedVersion||current.question===null||current.execution!=='agent_v1')return unavailable('request_unavailable');
 if(!['complete','unavailable'].includes(current.state))return unavailable(current.state==='unknown_acceptance'?'provider_acceptance_unknown':'request_not_terminal');
 if(input.mode==='retry'&&current.state!=='unavailable')return unavailable('retry_not_required');
 const row=(await context.db.query<{version:number;epoch:number;scope:{sources:unknown[]};original_agent_scope:unknown}>(`SELECT version,epoch,scope,original_agent_scope FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 FOR SHARE`,[context.scope.workspaceId,input.requestId,actor.userId])).rows[0];if(!row)return unavailable('request_unavailable');
 const receipts=(await context.db.query<{stage:string;attempt:number;dispatch_state:string;config_fingerprint:string;input_hash:string}>(`SELECT stage,attempt,dispatch_state,config_fingerprint,input_hash FROM crm_ask_financial_receipts WHERE workspace_id=$1 AND request_id=$2 ORDER BY request_version,request_epoch,stage,attempt FOR SHARE`,[context.scope.workspaceId,input.requestId])).rows;
 if(receipts.some(receipt=>['calling','unknown_acceptance','reserved'].includes(receipt.dispatch_state)))return unavailable('provider_acceptance_unknown');
 const purpose=await readAskPurpose(context,'answer');const limits=purpose?.agentLimits;
 if(!purpose||!limits)return unavailable('configured_allowance_unavailable');
 const unitCost=crmTokenCostCents(limits.maxInputBytes,limits.maxOutputTokens,purpose.inputTokenPriceMicros,purpose.outputTokenPriceMicros);
 if(unitCost===null||unitCost*limits.maxSteps>purpose.dailyCeilingCents||unitCost*limits.maxSteps>purpose.monthlyCeilingCents)return unavailable('budget_held');
 const originalScope=askAgentScopeSchema.safeParse(row.original_agent_scope);
 const scope=input.agentScope??(originalScope.success?originalScope.data:row.scope.sources.length>0?askAgentScopeSchema.parse({kind:'selected',sources:row.scope.sources}):null);
 if(!scope)return unavailable('scope_selection_required');
 const resolvedScope=await resolveAskAgentScope(context,scope);
 if(resolvedScope===null)return unavailable('source_unavailable');
 const allowance={...limits,ceilingCents:unitCost*limits.maxSteps};
 const previewHash=askFingerprint({requestId:input.requestId,version:row.version,epoch:row.epoch,mode:input.mode,question:current.question,scope,resolvedScope,purpose,receipts,originalScope:row.scope});
 return askAnswerInvestigationPreviewResultSchema.parse({available:true,reason:null,previewHash,scope,question:current.question,additionalAllowance:allowance});
}

/** Explicit commit creates new independently verified work; it cannot restart a paid attempt. */
export async function commitAskInvestigation(context:RepositoryContext,input:PreviewInput&{previewHash:string;commandId:string;clientVersion:string}){
 const preview=await previewAskInvestigation(context,input);
 if(!preview.available||preview.scope===null||preview.question===null)return {ok:false as const,reason:preview.reason??'investigation_unavailable'};
 if(preview.previewHash!==input.previewHash)return {ok:false as const,reason:'stale_investigation_preview'};
 const request=askAnswerRequestSchema.parse({commandId:input.commandId,clientVersion:input.clientVersion,question:preview.question,execution:'agent_v1',agentScope:preview.scope,scope:{sources:[]}});
 const created=await requestAskAnswer(context,request);
 if(!created.ok)return created;
 await recordCrmAuditEvent(context,{action:'crm.ask_investigation_committed',subjectKind:'crm_ask_request',subjectId:created.value.requestId,detail:{originRequestId:input.requestId,originVersion:input.expectedVersion,mode:input.mode,previewHash:input.previewHash}});
 return created;
}
