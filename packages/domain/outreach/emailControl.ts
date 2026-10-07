import {EMAIL_FIT_POLICY_VERSION} from './selection.ts';
import {QUALIFICATION_PROMPT_VERSION} from '../sourcing/qualificationStore.ts';
import {buildCommit} from '../release/identity.ts';
import {createHash} from 'node:crypto';
import {readSequenceVersion} from '../sequences/rows.ts';
import {readTemplateVersion} from '../templates/templates.ts';
import {campaignKind} from './settings.ts';
import {authorizationForMailbox} from './authorization.ts';
import {emailAdmissionEvaluationSchema,emailAdmissionSaveSchema,type OutreachControl} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
type Result={ok:true;value:{revision:number}}|{ok:false;reason:string};
type ControlRow={evaluation:unknown;revision:number;owner_user_id:string|null;mailbox_id:string|null;sequence_version_id:string|null;mailbox_binding:string|null;sequence_binding:string|null};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function bindings(ctx:RepositoryContext,input:{ownerUserId:string;mailboxId:string;sequenceVersionId:string}){
 const w=ctx.scope.workspaceId;
 const active=(await ctx.db.query("SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active'",[w,input.ownerUserId])).rows.length>0;
 if(!active)return {ok:false as const,reason:'owner_inactive'};
 const mailbox=(await ctx.db.query<{owner_user_id:string;provider_account_id:string|null;email_address:string;status:string}>('SELECT owner_user_id,provider_account_id,email_address,status FROM mailboxes WHERE workspace_id=$1 AND id=$2',[w,input.mailboxId])).rows[0];
 if(!mailbox||mailbox.owner_user_id!==input.ownerUserId)return {ok:false as const,reason:'owner_changed'};
 const auth=await authorizationForMailbox(ctx,input.mailboxId);if(!auth.allowed)return {ok:false as const,reason:'mailbox_not_authorized'};
 if(await campaignKind(ctx,input.sequenceVersionId)!=='email_first')return {ok:false as const,reason:'approved_email_sequence_required'};
 const sequence=await readSequenceVersion(ctx,input.sequenceVersionId);
 if(!sequence||sequence.state!=='published'||sequence.retiredAt!==null)return {ok:false as const,reason:'approved_email_sequence_required'};
 const templates=[];for(const step of sequence.steps)templates.push(await readTemplateVersion(ctx,step.templateVersionId!));
 if(templates.some(t=>!t||!t.approvedAt||t.retiredAt))return {ok:false as const,reason:'approved_email_sequence_required'};
 const mailboxBinding=digest({mailboxId:input.mailboxId,...mailbox,authorizationRevision:auth.revision});
 const sequenceBinding=digest({sequence,templates});
 return {ok:true as const,mailboxBinding,sequenceBinding,configurationSha256:digest({workspaceId:w,ownerUserId:input.ownerUserId,mailboxBinding,sequenceBinding})};
}
function evaluationMatches(value:unknown,configurationSha256:string):boolean {
 const parsed=emailAdmissionEvaluationSchema.safeParse(value);if(!parsed.success)return false;
 const e=parsed.data,commit=buildCommit(process.env);
 return commit!==null&&e.implementationCommit===commit&&e.policyVersion===EMAIL_FIT_POLICY_VERSION&&e.promptVersion===QUALIFICATION_PROMPT_VERSION&&e.configurationSha256===configurationSha256&&e.reviewedEligible>0&&e.falseEligible===0;
}
export async function readEmailAdmissionControl(ctx:RepositoryContext):Promise<OutreachControl['emailAdmission']>{
 if(ctx.scope.actor.kind!=='user'||ctx.scope.actor.role!=='admin')throw new Error('admin_required');
 const row=(await ctx.db.query<ControlRow>('SELECT * FROM outreach_email_admission_settings WHERE workspace_id=$1',[ctx.scope.workspaceId])).rows[0];
 const value:OutreachControl['emailAdmission']={revision:row?.revision??0,enabled:false,ownerUserId:row?.owner_user_id??null,mailboxId:row?.mailbox_id??null,sequenceVersionId:row?.sequence_version_id??null,evaluation:emailAdmissionEvaluationSchema.safeParse(row?.evaluation).data??null,configurationSha256:null,ready:false,reasons:['configuration_required']};
 if(!value.ownerUserId||!value.mailboxId||!value.sequenceVersionId)return value;
 const current=await bindings(ctx,{ownerUserId:value.ownerUserId,mailboxId:value.mailboxId,sequenceVersionId:value.sequenceVersionId});
 if(!current.ok){value.reasons=[current.reason];return value;}
 value.configurationSha256=current.configurationSha256;
 value.reasons=[];
 if(current.mailboxBinding!==row!.mailbox_binding)value.reasons.push('mailbox_binding_changed');
 if(current.sequenceBinding!==row!.sequence_binding)value.reasons.push('sequence_binding_changed');
 if(!row!.evaluation)value.reasons.push('evaluation_required');
 else if(!evaluationMatches(row!.evaluation,current.configurationSha256))value.reasons.push('evaluation_mismatch');
 value.reasons.push('activation_not_available');
 return value;
}
export async function saveEmailAdmissionControl(ctx:RepositoryContext,input:unknown):Promise<Result>{
 const actor=ctx.scope.actor;if(actor.kind!=='user'||actor.role!=='admin')return {ok:false,reason:'admin_required'};
 const parsed=emailAdmissionSaveSchema.safeParse(input);if(!parsed.success)return {ok:false,reason:'invalid_input'};
 const v=parsed.data;
 await lockSendGateForStopFact(ctx);
 const old=await readEmailAdmissionControl(ctx);if(old.revision!==v.expectedRevision)return {ok:false,reason:'stale_revision'};
 if(v.enabled)return {ok:false,reason:'activation_not_available'};
 const configured=[v.ownerUserId,v.mailboxId,v.sequenceVersionId].filter(x=>x!==null).length;
 if(configured!==0&&configured!==3||configured===0&&v.evaluation!==null)return {ok:false,reason:'configuration_incomplete'};
 let current:Awaited<ReturnType<typeof bindings>>|null=null;
 if(configured===3){
  if(v.ownerUserId!==actor.userId)return {ok:false,reason:'owner_changed'};
  current=await bindings(ctx,{ownerUserId:v.ownerUserId!,mailboxId:v.mailboxId!,sequenceVersionId:v.sequenceVersionId!});
  if(!current.ok)return current;
  if(v.evaluation&&!evaluationMatches(v.evaluation,current.configurationSha256))return {ok:false,reason:'evaluation_mismatch'};
 }
 const revision=old.revision+1;
 await ctx.db.query(`INSERT INTO outreach_email_admission_settings(workspace_id,revision,owner_user_id,mailbox_id,sequence_version_id,mailbox_binding,sequence_binding,evaluation) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
 ON CONFLICT(workspace_id) DO UPDATE SET enabled=false,revision=EXCLUDED.revision,owner_user_id=EXCLUDED.owner_user_id,mailbox_id=EXCLUDED.mailbox_id,sequence_version_id=EXCLUDED.sequence_version_id,mailbox_binding=EXCLUDED.mailbox_binding,sequence_binding=EXCLUDED.sequence_binding,evaluation=EXCLUDED.evaluation,updated_at=now()`,[ctx.scope.workspaceId,revision,v.ownerUserId,v.mailboxId,v.sequenceVersionId,current?.ok?current.mailboxBinding:null,current?.ok?current.sequenceBinding:null,v.evaluation?JSON.stringify(v.evaluation):null]);
 await recordCrmAuditEvent(ctx,{action:'outreach.email_control_saved',subjectKind:'workspace',subjectId:ctx.scope.workspaceId,detail:{revision,enabled:false,ownerUserId:v.ownerUserId,mailboxId:v.mailboxId,sequenceVersionId:v.sequenceVersionId,evaluationSha256:v.evaluation?.reportSha256??null}});
 return {ok:true,value:{revision}};
}

/** Worker-only live binding check. Caller holds the workspace send gate. This
 * checks stored authority; it never creates or enables it. */
export async function automaticEmailConfiguration(ctx:RepositoryContext,expectedRevision:number){
 if(ctx.scope.actor.kind!=='system'||ctx.scope.actor.component!=='worker')return {ok:false as const,reason:'automatic_email_capability_required'};
 const row=(await ctx.db.query<ControlRow & {enabled:boolean}>('SELECT * FROM outreach_email_admission_settings WHERE workspace_id=$1 FOR UPDATE',[ctx.scope.workspaceId])).rows[0];
 if(!row?.enabled)return {ok:false as const,reason:'automatic_email_disabled'};
 if(row.revision!==expectedRevision)return {ok:false as const,reason:'control_changed'};
 if(!row.owner_user_id||!row.mailbox_id||!row.sequence_version_id)return {ok:false as const,reason:'configuration_required'};
 await ctx.db.query('SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[ctx.scope.workspaceId,row.owner_user_id]);
 await ctx.db.query('SELECT id FROM mailboxes WHERE workspace_id=$1 AND id=$2 FOR SHARE',[ctx.scope.workspaceId,row.mailbox_id]);
 // Retirement takes sequence then version locks. Hold shared locks in that order
 // so evaluated content cannot retire between the binding check and enrollment.
 await ctx.db.query(`SELECT s.id FROM sequences s JOIN sequence_versions v ON v.workspace_id=s.workspace_id AND v.sequence_id=s.id WHERE v.workspace_id=$1 AND v.id=$2 FOR SHARE OF s`,[ctx.scope.workspaceId,row.sequence_version_id]);
 await ctx.db.query('SELECT id FROM sequence_versions WHERE workspace_id=$1 AND id=$2 FOR SHARE',[ctx.scope.workspaceId,row.sequence_version_id]);
 await ctx.db.query(`SELECT t.id FROM template_versions t WHERE t.workspace_id=$1 AND t.id IN (SELECT template_version_id FROM sequence_steps WHERE workspace_id=$1 AND sequence_version_id=$2) ORDER BY t.id FOR SHARE`,[ctx.scope.workspaceId,row.sequence_version_id]);
 const current=await bindings(ctx,{ownerUserId:row.owner_user_id,mailboxId:row.mailbox_id,sequenceVersionId:row.sequence_version_id});
 if(!current.ok)return current;
 if(current.mailboxBinding!==row.mailbox_binding)return {ok:false as const,reason:'mailbox_binding_changed'};
 if(current.sequenceBinding!==row.sequence_binding)return {ok:false as const,reason:'sequence_binding_changed'};
 if(!evaluationMatches(row.evaluation,current.configurationSha256))return {ok:false as const,reason:'evaluation_mismatch'};
 return {ok:true as const,value:{ownerUserId:row.owner_user_id,mailboxId:row.mailbox_id,sequenceVersionId:row.sequence_version_id,revision:row.revision,evaluationSha256:emailAdmissionEvaluationSchema.parse(row.evaluation).reportSha256}};
}
