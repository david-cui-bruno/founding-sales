import {readBusinessPolicy,activeBusinessActor} from './acquisition.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {enqueueJob} from '../jobs/jobStore.ts';
import type {businessSelectionPayloadSchema} from '@fss/contracts';
import type {z} from 'zod';
export async function requestBusinessSelection(context:RepositoryContext,input:z.infer<typeof businessSelectionPayloadSchema>){
 const actor=context.scope.actor,policy=await readBusinessPolicy(context,input.mailboxId);
 if(actor.kind!=='user'||!policy||policy.ownerUserId!==actor.userId||!await activeBusinessActor(context))return {ok:false as const,reason:'business_owner_required'};
 if(policy.generation!==input.expectedGeneration||policy.accountBinding!==input.expectedAccountBinding||policy.revision!==input.expectedPolicyRevision)return {ok:false as const,reason:'mailbox_binding_changed'};
 const imported=(await context.db.query<{id:string}>(`SELECT i.id FROM crm_mail_imports i JOIN crm_mail_capture_controls c ON c.workspace_id=i.workspace_id AND c.mailbox_id=i.mailbox_id WHERE i.workspace_id=$1 AND i.mailbox_id=$2 AND i.owner_user_id=$3 AND i.account_binding=$4 AND i.generation=$5 AND i.policy_revision=$6 AND c.revision=i.controls_revision AND c.enabled ORDER BY i.observed_at DESC LIMIT 1`,[context.scope.workspaceId,input.mailboxId,actor.userId,input.expectedAccountBinding,input.expectedGeneration,input.expectedPolicyRevision])).rows[0];
 if(!imported)return {ok:false as const,reason:'verified_acquisition_setup_required'};
 const job=await enqueueJob(context.db,{workspaceId:context.scope.workspaceId,kind:'crm.business_selection',idempotencyKey:`business-selection:${imported.id}:${input.providerMessageId}`,payload:{mailboxId:input.mailboxId,expectedGeneration:input.expectedGeneration,expectedAccountBinding:input.expectedAccountBinding,expectedPolicyRevision:input.expectedPolicyRevision,providerMessageId:input.providerMessageId,importId:imported.id,ownerUserId:actor.userId}});
 return {ok:true as const,value:{status:'queued' as const,previewJobId:job.jobId,captureAllowed:false as const}};
}

export async function readBusinessSelection(context:RepositoryContext,input:{mailboxId:string;previewJobId:string}){
 const actor=context.scope.actor,policy=await readBusinessPolicy(context,input.mailboxId);
 if(actor.kind!=='user'||!policy||policy.ownerUserId!==actor.userId||!await activeBusinessActor(context))return null;
 const job=(await context.db.query<{state:string;payload:{ownerUserId?:string;expectedAccountBinding?:string;expectedGeneration?:number;selectionOutcome?:{outcome?:string;conversationId?:string}}}>("SELECT state,payload FROM jobs WHERE workspace_id=$1 AND id=$2 AND kind='crm.business_selection' AND payload->>'mailboxId'=$3",[context.scope.workspaceId,input.previewJobId,input.mailboxId])).rows[0];
 if(!job||job.payload.ownerUserId!==actor.userId)return null;
 if(job.payload.expectedAccountBinding!==policy.accountBinding||job.payload.expectedGeneration!==policy.generation)return {state:'unavailable' as const,reason:'mailbox_binding_changed',conversationId:null};
 const outcome=job.payload.selectionOutcome;
 if(outcome?.outcome==='preview_available'&&outcome.conversationId){const row=(await context.db.query("SELECT id FROM crm_business_conversations WHERE workspace_id=$1 AND id=$2 AND mailbox_id=$3 AND account_binding=$4 AND metadata_availability='available'",[context.scope.workspaceId,outcome.conversationId,input.mailboxId,policy.accountBinding])).rows[0];return row?{state:'ready' as const,reason:null,conversationId:outcome.conversationId}:{state:'unavailable' as const,reason:'metadata_deleted',conversationId:null};}
 if(outcome)return {state:'unavailable' as const,reason:outcome.outcome??'selection_unavailable',conversationId:null};
 return ['queued','retryable','running'].includes(job.state)?{state:'pending' as const,reason:null,conversationId:null}:{state:'unavailable' as const,reason:'selection_provider_read_unavailable',conversationId:null};
}
