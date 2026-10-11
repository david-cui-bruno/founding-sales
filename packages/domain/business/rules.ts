import {activeBusinessActor,readBusinessPolicy,lockBusinessMetadataAddresses} from './acquisition.ts';
import {normalizeIdentityEndpoint} from '../crm/endpoints.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import type {businessRulePayloadSchema} from '@fss/contracts';
import type {z} from 'zod';
export async function readBusinessRules(context:RepositoryContext,input:{mailboxId:string}){
 const policy=await readBusinessPolicy(context,input.mailboxId);const actor=context.scope.actor;
 if(!policy||actor.kind!=='user'||policy.ownerUserId!==actor.userId||!await activeBusinessActor(context))return null;
 const rows=(await context.db.query<{endpoint:string;decision:'include'|'exclude';revision:number;active:boolean}>('SELECT endpoint,decision,revision,active FROM crm_business_correspondent_rules WHERE workspace_id=$1 AND mailbox_id=$2 AND owner_user_id=$3 AND account_binding=$4 ORDER BY endpoint LIMIT 100',[context.scope.workspaceId,input.mailboxId,actor.userId,policy.accountBinding])).rows;
 return {mailboxId:input.mailboxId,accountBinding:policy.accountBinding,generation:policy.generation,rules:rows};
}
export async function saveBusinessRule(context:RepositoryContext,input:z.infer<typeof businessRulePayloadSchema>){
 const actor=context.scope.actor;const policy=await readBusinessPolicy(context,input.mailboxId);
 if(actor.kind!=='user'||!policy||policy.ownerUserId!==actor.userId||!await activeBusinessActor(context))return {ok:false as const,reason:'business_owner_required'};
 if(policy.generation!==input.expectedGeneration||policy.accountBinding!==input.expectedAccountBinding||policy.reasons.includes('mailbox_disconnected'))return {ok:false as const,reason:'mailbox_binding_changed'};
 const endpoint=normalizeIdentityEndpoint('email',input.endpoint);if(!endpoint)return {ok:false as const,reason:'endpoint_invalid'};
 await lockBusinessMetadataAddresses(context,[endpoint]);
 const old=(await context.db.query<{revision:number}>('SELECT revision FROM crm_business_correspondent_rules WHERE workspace_id=$1 AND mailbox_id=$2 AND account_binding=$3 AND endpoint=$4 FOR UPDATE',[context.scope.workspaceId,input.mailboxId,input.expectedAccountBinding,endpoint])).rows[0];
 if((old?.revision??0)!==input.expectedRevision)return {ok:false as const,reason:'stale_rule'};
 const revision=input.expectedRevision+1;
 await context.db.query('INSERT INTO crm_business_correspondent_rules(workspace_id,mailbox_id,owner_user_id,account_binding,endpoint,decision,revision,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,mailbox_id,account_binding,endpoint) DO UPDATE SET decision=EXCLUDED.decision,revision=EXCLUDED.revision,active=EXCLUDED.active',[context.scope.workspaceId,input.mailboxId,actor.userId,input.expectedAccountBinding,endpoint,input.decision,revision,input.active]);
 // Conversation decisions take precedence; undecided existing conversations must immediately fence future capture.
 await context.db.query("UPDATE crm_business_conversations SET category='uncertain',reason='correspondent_rule_changed',metadata_revision=metadata_revision+1 WHERE workspace_id=$1 AND mailbox_id=$2 AND account_binding=$3 AND human_decision IS NULL AND metadata_availability='available' AND participants ? $4",[context.scope.workspaceId,input.mailboxId,input.expectedAccountBinding,endpoint]);
 await recordCrmAuditEvent(context,{action:'crm.business_rule_saved',subjectKind:'mailbox',subjectId:input.mailboxId,detail:{revision,active:input.active,decision:input.decision}});
 return {ok:true as const,value:{revision,captureAllowed:false as const}};
}
