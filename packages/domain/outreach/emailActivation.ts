import {emailAdmissionActivationProofSchema} from '@fss/contracts';
import {createHash,randomUUID} from 'node:crypto';
import {isImageDigest,emailAdmissionEvaluationSchema} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {currentEmailAdmissionBindings,emailAdmissionEvaluationMatches} from './emailControl.ts';
import {buildCommit} from '../release/identity.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {inspectEmailAdmissionProof} from './emailActivationEvidence.ts';
import {readSenderReadiness,readRampStanding} from '../outbound/ramp.ts';
import {REQUIRED_SCHEMA} from '../db/schemaRange.ts';
export interface EmailAdmissionRuntime {implementationCommit:string|null;imageDigest:string|null;side:'api'|'worker';production:boolean;schemaVersion:number;deploymentSendingEnabled:boolean}
export interface EmailAdmissionActivationProof {
 version:1;evaluationReportJson:string;
 release:{recordReference:string;observedAt:string;apiDigest:string;workerDigest:string;schemaVersion:number;deploymentReceiptJson:string;postSmokeReadback:'existing'|'created'};
 received:{mailboxId:string;senderAddress:string;observedAt:string;messageReference:string;headerText:string;reviewReference:string};
 sequence:{sequenceVersionId:string;renderedEvidenceJson:string};
 interruptions:{originalOutboundId:string;originalEnrollmentId:string;providerId:string;observedAt:string;integrationEvidenceJson:string;reviewReference:string};
}
type Result<T>={ok:true;value:T}|{ok:false;reason:string};
export interface EmailAdmissionReadiness {enabled:boolean;controlRevision:number;receiptId:string|null;readinessSha256:string|null;ready:boolean;reasons:string[]}
type Row={enabled:boolean;revision:number;owner_user_id:string|null;mailbox_id:string|null;sequence_version_id:string|null;evaluation:unknown;mailbox_binding:string|null;sequence_binding:string|null;activation_receipt_id?:string|null}
function canonical(value:unknown):string {
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}';
}
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
function runtimeReason(runtime?:EmailAdmissionRuntime):string|null{return !runtime||!/^[a-f0-9]{40}$/u.test(runtime.implementationCommit??'')||runtime.implementationCommit!==buildCommit(process.env)||!isImageDigest(runtime.imageDigest)||runtime.schemaVersion!==REQUIRED_SCHEMA?'runtime_identity_unknown':runtime.deploymentSendingEnabled===true?null:'deployment_sending_disabled';}
export async function readEmailAdmissionReadiness(ctx:RepositoryContext,runtime?:EmailAdmissionRuntime):Promise<EmailAdmissionReadiness>{
 if(ctx.scope.actor.kind!=='user'||ctx.scope.actor.role!=='admin')throw new Error('admin_required');
 const row=(await ctx.db.query<Row>('SELECT * FROM outreach_email_admission_settings WHERE workspace_id=$1',[ctx.scope.workspaceId])).rows[0];
 const answer:EmailAdmissionReadiness={enabled:row?.enabled??false,controlRevision:row?.revision??0,receiptId:null,readinessSha256:null,ready:false,reasons:[]};
 const problem=runtimeReason(runtime);if(problem)answer.reasons.push(problem);
 if(!row?.owner_user_id||!row.mailbox_id||!row.sequence_version_id){answer.reasons.push('configuration_required');return answer;}
 const binding=await currentEmailAdmissionBindings(ctx,{ownerUserId:row.owner_user_id,mailboxId:row.mailbox_id,sequenceVersionId:row.sequence_version_id});
 if(!binding.ok){answer.reasons.push(binding.reason);return answer;}
 if(binding.mailboxBinding!==row.mailbox_binding)answer.reasons.push('mailbox_binding_changed');
 if(binding.sequenceBinding!==row.sequence_binding)answer.reasons.push('sequence_binding_changed');
 if(!emailAdmissionEvaluationMatches(row.evaluation,binding.configurationSha256))answer.reasons.push('evaluation_mismatch');
 const receipt=await currentReceipt(ctx,row);
 if(!receipt){answer.reasons.push('activation_receipt_required');return answer;}
 answer.receiptId=receipt.id;
 if(!problem){const issue=await inspectEmailAdmissionProof(ctx,{proof:receipt.proof,evaluation:row.evaluation,ownerUserId:row.owner_user_id,mailboxId:row.mailbox_id,sequenceVersionId:row.sequence_version_id},runtime!);if(issue)answer.reasons.push(issue);}
 if(receipt.configuration_sha256!==binding.configurationSha256||receipt.proof_sha256!==hash(canonical(receipt.proof)))answer.reasons.push('activation_receipt_changed');
 const sender=await readSenderReadiness(ctx,row.mailbox_id);answer.reasons.push(...sender.reasons);
 const ramp=await readRampStanding(ctx,row.mailbox_id);if(!ramp||ramp.effectiveCap<=0||!ramp.readiness.ready)answer.reasons.push('sender_unhealthy');
 answer.reasons=[...new Set(answer.reasons)];
 answer.readinessSha256=hash(JSON.stringify({controlRevision:row.revision,receiptId:receipt.id,proofSha256:receipt.proof_sha256,configurationSha256:binding.configurationSha256,implementationCommit:runtime?.implementationCommit,imageDigest:runtime?.imageDigest,schemaVersion:runtime?.schemaVersion,reasons:answer.reasons}));
 answer.ready=answer.reasons.length===0;
 return answer;
}

type Receipt={id:string;control_revision:number;configuration_sha256:string;proof:EmailAdmissionActivationProof;proof_sha256:string}
async function currentReceipt(ctx:RepositoryContext,row:Row):Promise<Receipt|null>{
 const revision=row.enabled?row.revision-1:row.revision;
 return (await ctx.db.query<Receipt>(`SELECT id,control_revision,configuration_sha256,proof,proof_sha256 FROM outreach_email_admission_activation_receipts WHERE workspace_id=$1 AND control_revision=$2 AND ($3::uuid IS NULL OR id=$3) ORDER BY recorded_at DESC,id DESC LIMIT 1`,[ctx.scope.workspaceId,revision,row.enabled?row.activation_receipt_id??null:null])).rows[0]??null;
}
export async function prepareEmailAdmissionActivation(ctx:RepositoryContext,input:{expectedControlRevision:number;proof:EmailAdmissionActivationProof},runtime?:EmailAdmissionRuntime):Promise<Result<{receiptId:string;readinessSha256:string}>>{
 if(ctx.scope.actor.kind!=='user'||ctx.scope.actor.role!=='admin')return {ok:false,reason:'admin_required'};
 const problem=runtimeReason(runtime);if(problem)return {ok:false,reason:problem};
 if(!emailAdmissionActivationProofSchema.safeParse(input.proof).success)return {ok:false,reason:'activation_evidence_invalid'};
 await lockSendGateForStopFact(ctx);
 const row=(await ctx.db.query<Row>('SELECT * FROM outreach_email_admission_settings WHERE workspace_id=$1 FOR UPDATE',[ctx.scope.workspaceId])).rows[0];
 if(!row||row.revision!==input.expectedControlRevision)return {ok:false,reason:'stale_revision'};
 if(row.enabled)return {ok:false,reason:'disable_before_preparing'};
 if(row.owner_user_id!==ctx.scope.actor.userId)return {ok:false,reason:'owner_changed'};
 if(!row.owner_user_id||!row.mailbox_id||!row.sequence_version_id)return {ok:false,reason:'configuration_required'};
 await lockActivationBindings(ctx,row);
 const bindings=await currentEmailAdmissionBindings(ctx,{ownerUserId:row.owner_user_id,mailboxId:row.mailbox_id,sequenceVersionId:row.sequence_version_id});if(!bindings.ok)return bindings;
 if(bindings.mailboxBinding!==row.mailbox_binding||bindings.sequenceBinding!==row.sequence_binding||!emailAdmissionEvaluationMatches(row.evaluation,bindings.configurationSha256))return {ok:false,reason:'evaluation_mismatch'};
 const issue=await inspectEmailAdmissionProof(ctx,{proof:input.proof,evaluation:row.evaluation,ownerUserId:row.owner_user_id,mailboxId:row.mailbox_id,sequenceVersionId:row.sequence_version_id},runtime!);if(issue)return {ok:false,reason:issue};
 const receiptId=randomUUID(),proofText=JSON.stringify(input.proof),proofSha256=hash(canonical(input.proof));
 await ctx.db.query('INSERT INTO outreach_email_admission_activation_receipts(workspace_id,id,owner_user_id,control_revision,configuration_sha256,proof,proof_sha256) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)',[ctx.scope.workspaceId,receiptId,row.owner_user_id,row.revision,bindings.configurationSha256,proofText,proofSha256]);
 await recordCrmAuditEvent(ctx,{action:'outreach.email_activation_prepared',subjectKind:'workspace',subjectId:ctx.scope.workspaceId,detail:{receiptId,controlRevision:row.revision,proofSha256,evaluationSha256:emailAdmissionEvaluationSchema.parse(row.evaluation).reportSha256,evidenceKind:'operator_reviewed_documentary'}});
 const readiness=await readEmailAdmissionReadiness(ctx,runtime);
 return {ok:true,value:{receiptId,readinessSha256:readiness.readinessSha256!}};
}
export async function activateEmailAdmission(ctx:RepositoryContext,input:{expectedControlRevision:number;expectedReadinessSha256:string;receiptId:string},runtime?:EmailAdmissionRuntime):Promise<Result<{revision:number}>>{
 if(ctx.scope.actor.kind!=='user'||ctx.scope.actor.role!=='admin')return {ok:false,reason:'admin_required'};
 await lockSendGateForStopFact(ctx);
 const row=(await ctx.db.query<Row>('SELECT * FROM outreach_email_admission_settings WHERE workspace_id=$1 FOR UPDATE',[ctx.scope.workspaceId])).rows[0];
 if(!row||row.revision!==input.expectedControlRevision)return {ok:false,reason:'stale_revision'};
 if(row.owner_user_id!==ctx.scope.actor.userId)return {ok:false,reason:'owner_changed'};
 if(row.enabled)return {ok:false,reason:'already_enabled'};
 await lockActivationBindings(ctx,row);
 const readiness=await readEmailAdmissionReadiness(ctx,runtime);
 if(!readiness.ready)return {ok:false,reason:readiness.reasons[0]??'activation_not_ready'};
 if(readiness.receiptId!==input.receiptId||readiness.readinessSha256!==input.expectedReadinessSha256)return {ok:false,reason:'activation_readiness_changed'};
 const revision=row.revision+1;
 await ctx.db.query('UPDATE outreach_email_admission_settings SET enabled=true,revision=$2,activation_receipt_id=$3,updated_at=now() WHERE workspace_id=$1',[ctx.scope.workspaceId,revision,input.receiptId]);
 await recordCrmAuditEvent(ctx,{action:'outreach.email_activation_enabled',subjectKind:'workspace',subjectId:ctx.scope.workspaceId,detail:{revision,receiptId:input.receiptId,readinessSha256:input.expectedReadinessSha256,previousRevision:row.revision}});
 return {ok:true,value:{revision}};
}
export async function verifyEmailAdmissionActivation(ctx:RepositoryContext,input:{controlRevision:number;activationReceiptId:string|null},runtime?:EmailAdmissionRuntime):Promise<Result<{receiptId:string;proofSha256:string}>>{
 const problem=runtimeReason(runtime);if(problem)return {ok:false,reason:problem};
 if(!input.activationReceiptId)return {ok:false,reason:'activation_receipt_required'};
 const row=(await ctx.db.query<Row>('SELECT * FROM outreach_email_admission_settings WHERE workspace_id=$1',[ctx.scope.workspaceId])).rows[0];
 if(!row?.enabled||row.revision!==input.controlRevision||row.activation_receipt_id!==input.activationReceiptId)return {ok:false,reason:'activation_control_changed'};
 const receipt=await currentReceipt(ctx,row);if(!receipt||receipt.proof_sha256!==hash(canonical(receipt.proof)))return {ok:false,reason:'activation_receipt_changed'};
 if(!row.owner_user_id||!row.mailbox_id||!row.sequence_version_id)return {ok:false,reason:'configuration_required'};
 const binding=await currentEmailAdmissionBindings(ctx,{ownerUserId:row.owner_user_id,mailboxId:row.mailbox_id,sequenceVersionId:row.sequence_version_id});if(!binding.ok)return binding;
 if(receipt.configuration_sha256!==binding.configurationSha256)return {ok:false,reason:'activation_configuration_changed'};
 const issue=await inspectEmailAdmissionProof(ctx,{proof:receipt.proof,evaluation:row.evaluation,ownerUserId:row.owner_user_id,mailboxId:row.mailbox_id,sequenceVersionId:row.sequence_version_id},runtime!);if(issue)return {ok:false,reason:issue};
 return {ok:true,value:{receiptId:receipt.id,proofSha256:receipt.proof_sha256}};
}

async function lockActivationBindings(ctx:RepositoryContext,row:Row){
 await ctx.db.query('SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[ctx.scope.workspaceId,row.owner_user_id]);
 await ctx.db.query('SELECT id FROM mailboxes WHERE workspace_id=$1 AND id=$2 FOR SHARE',[ctx.scope.workspaceId,row.mailbox_id]);
 await ctx.db.query(`SELECT s.id FROM sequences s JOIN sequence_versions v ON v.workspace_id=s.workspace_id AND v.sequence_id=s.id WHERE v.workspace_id=$1 AND v.id=$2 FOR SHARE OF s`,[ctx.scope.workspaceId,row.sequence_version_id]);
 await ctx.db.query('SELECT id FROM sequence_versions WHERE workspace_id=$1 AND id=$2 FOR SHARE',[ctx.scope.workspaceId,row.sequence_version_id]);
 await ctx.db.query(`SELECT id FROM template_versions WHERE workspace_id=$1 AND id IN (SELECT template_version_id FROM sequence_steps WHERE workspace_id=$1 AND sequence_version_id=$2) ORDER BY id FOR SHARE`,[ctx.scope.workspaceId,row.sequence_version_id]);
}
