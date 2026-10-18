import {createHash} from 'node:crypto';
import {CRM_MAIL_CAPTURE_CONSENT,crmCapabilityConfigurationSchema,type crmMailCaptureControlsSaveSchema,type crmAskPurposeSaveSchema,type CrmCapabilityConfiguration,type CrmOwnerApproval} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor} from './identityAccess.ts';
import {METADATA_REVIEW_DISCLOSURE,businessAccountBinding} from '../business/acquisition.ts';
import {MAIL_CAPTURE_VERSION} from '../mail/crmSources.ts';
import {GMAIL_SCOPES} from '../mail/types.ts';
export const CRM_SUPPORTED_ASK_VERSIONS=Object.freeze({processorVersion:'ask-answer-v1',retrievalVersion:'lexical-original-v1',answerVersion:'literal-v1',supportVersion:'exact-original-v1',chunkerVersion:'lexical-original-v1'});
export const CRM_SUPPORTED_AGENT_ASK_VERSIONS=Object.freeze({processorVersion:'ask-agent-v2',retrievalVersion:'ask-hybrid-v2',answerVersion:'ask-agent-v2',supportVersion:'cited-evidence-v1',chunkerVersion:'lexical-original-v1'});
export const CRM_MAIL_CAPTURE_DISCLOSURE_TEXT=CRM_MAIL_CAPTURE_CONSENT.text;
export const CRM_MAIL_CAPTURE_DISCLOSURE=Object.freeze({version:CRM_MAIL_CAPTURE_CONSENT.version,sha256:CRM_MAIL_CAPTURE_CONSENT.sha256});
type Capability=CrmCapabilityConfiguration['capability'];
export interface CrmCapabilityRuntime {implementationCommit:string|null;imageDigest:string|null;side:'api'|'worker';schemaVersion:number;adapterAvailable(configuration:CrmCapabilityConfiguration):boolean}
export function crmCapabilityConfigurationFingerprint(configuration:CrmCapabilityConfiguration){return createHash('sha256').update(JSON.stringify(crmCapabilityConfigurationSchema.parse(configuration))).digest('hex');}
const tables={metadata_review:'crm_business_policies',mail_capture:'crm_mail_capture_controls',crm_extraction:'crm_extraction_purposes',ask_answer:'crm_ask_purposes'} as const;
async function snapshot(context:RepositoryContext,input:{capability:Capability;purpose?:'answer'|'embedding';mailboxId?:string},lock:boolean|'share'=false){
 if(context.scope.actor.kind!=='user'||!await activeIdentityActor(context)||input.capability==='mail_backfill')return null;
 const capability=input.capability;const table=tables[capability];const acquisition=capability==='metadata_review'||capability==='mail_capture';
 if(acquisition&&!input.mailboxId)return null;
 const row=(await context.db.query<Record<string,unknown>>(`SELECT * FROM ${table} WHERE workspace_id=$1 ${acquisition?'AND mailbox_id=$2':capability==='ask_answer'?"AND purpose=$2":''} ${lock==='share'?'FOR SHARE':lock?'FOR UPDATE':''}`,[context.scope.workspaceId,...acquisition?[input.mailboxId]:capability==='ask_answer'?[input.purpose??'answer']:[]])).rows[0];
 if(!row)return {row:null,configuration:null,table,acquisition};
 const common={workspaceId:context.scope.workspaceId,ownerUserId:String(row[acquisition?'owner_user_id':'approved_by']),revision:Number(row['revision'])};let config:unknown;
 if(acquisition){
  const m=(await context.db.query<{[key:string]:unknown;id:string;owner_user_id:string;email_address:string;provider_account_id:string;generation:number;status:string}>('SELECT * FROM mailboxes WHERE workspace_id=$1 AND id=$2 FOR SHARE',[context.scope.workspaceId,input.mailboxId])).rows[0];
  if(!m||m.status!=='connected'||m.owner_user_id!==common.ownerUserId||m.provider_account_id!==row['provider_account_id']||m.generation!==row['generation']||businessAccountBinding(context.scope.workspaceId,m)!==row['account_binding'])return {row,configuration:null,table,acquisition};
  const mailbox={mailboxId:m.id,providerAccountId:m.provider_account_id,generation:m.generation,accountBinding:String(row['account_binding'])};
  config=capability==='metadata_review'?{...common,...mailbox,capability,disclosureVersion:row['disclosure_version'],disclosureSha256:row['disclosure_sha256'],scopeDays:90}:{...common,...mailbox,capability,policyRevision:Number(row['policy_revision']),disclosureVersion:row['disclosure_version'],disclosureSha256:row['disclosure_sha256'],grantReceipt:row['grant_receipt'],providerPolicyReceipt:row['provider_policy_receipt'],evaluationReceipt:row['evaluation_receipt'],releaseReceipt:row['release_receipt'],captureVersion:MAIL_CAPTURE_VERSION};
 }else{
  const route={endpointId:row['endpoint_id'],modelVersion:row['model_version'],accessGrantVersion:row['access_grant_version'],dataHandlingVersion:row['data_handling_version'],dailyCeilingCents:row['daily_ceiling_cents'],monthlyCeilingCents:row['monthly_ceiling_cents'],inputTokenPriceMicros:row['input_token_price_micros'],outputTokenPriceMicros:row['output_token_price_micros']};
  config=capability==='crm_extraction'?{...common,...route,capability,processorVersion:'crm-extract-v1'}:{...common,...route,capability,purpose:row['purpose'],...row['agent_limits']===null||row['agent_limits']===undefined?{}:{agentLimits:row['agent_limits']},...row['embedding_dimensions']===null||row['embedding_dimensions']===undefined?{}:{embeddingDimensions:row['embedding_dimensions']},evaluationFingerprint:row['evaluation_fingerprint'],processorVersion:row['processor_version'],retrievalVersion:row['retrieval_version'],answerVersion:row['answer_version'],supportVersion:row['support_version'],chunkerVersion:row['chunker_version']};
 }
 const parsed=crmCapabilityConfigurationSchema.safeParse(config);return {row,configuration:parsed.success?parsed.data:null,table,acquisition};
}
export interface CrmOwnerAuthority {configuration:CrmCapabilityConfiguration;ownerApprovalId:string;validUntil:string;qualityTier:'acquisition'|'provisional_owner'|'representative';limitations:string[]}
function compatible(configuration:CrmCapabilityConfiguration,runtime?:CrmCapabilityRuntime){
 if(!runtime)return false;
 try{if(!runtime.adapterAvailable(structuredClone(configuration)))return false;}catch{return false;}
 if(configuration.capability==='metadata_review')return configuration.disclosureVersion===METADATA_REVIEW_DISCLOSURE.version&&configuration.disclosureSha256===METADATA_REVIEW_DISCLOSURE.sha256;
 if(configuration.capability==='mail_capture')return configuration.disclosureVersion===CRM_MAIL_CAPTURE_DISCLOSURE.version&&configuration.disclosureSha256===CRM_MAIL_CAPTURE_DISCLOSURE.sha256;
 if(configuration.capability==='ask_answer')return [CRM_SUPPORTED_ASK_VERSIONS,CRM_SUPPORTED_AGENT_ASK_VERSIONS].some(versions=>Object.entries(versions).every(([key,value])=>configuration[key as keyof typeof versions]===value));
 return configuration.capability!=='crm_extraction'||configuration.processorVersion==='crm-extract-v1';
}
async function verifyOwnerApproval(context:RepositoryContext,configuration:CrmCapabilityConfiguration,approvalId:string,runtime?:CrmCapabilityRuntime):Promise<CrmOwnerAuthority|null>{
 if(!compatible(configuration,runtime)||context.scope.actor.kind!=='user'||configuration.ownerUserId!==context.scope.actor.userId||!await activeIdentityActor(context))return null;
 const row=(await context.db.query<{id:string;quality_tier:CrmOwnerAuthority['qualityTier'];limitations:string[]}>('SELECT id,quality_tier,limitations FROM crm_capability_owner_approvals WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 AND capability=$4 AND configuration_sha256=$5',[configuration.workspaceId,approvalId,configuration.ownerUserId,configuration.capability,crmCapabilityConfigurationFingerprint(configuration)])).rows[0];
 if(!row)return null;
 if('mailboxId' in configuration){
  const grant=(await context.db.query<{granted_scopes:string[]}>('SELECT granted_scopes FROM mailbox_oauth_grant_observations WHERE workspace_id=$1 AND mailbox_id=$2 AND owner_user_id=$3 AND provider_account_id=$4 AND generation=$5 ORDER BY observed_at DESC LIMIT 1',[configuration.workspaceId,configuration.mailboxId,configuration.ownerUserId,configuration.providerAccountId,configuration.generation])).rows[0];
  if(!grant||!GMAIL_SCOPES.every(scope=>grant.granted_scopes.includes(scope)))return null;
  if(configuration.capability==='mail_capture'){
   const policy=await verifyCurrentCrmCapability(context,{capability:'metadata_review',mailboxId:configuration.mailboxId},runtime);
   if(!policy||policy.configuration.revision!==configuration.policyRevision)return null;
  }
 }
 return {configuration,ownerApprovalId:row.id,validUntil:'9999-12-31T23:59:59.999Z',qualityTier:row.quality_tier,limitations:row.limitations};
}
export async function readCrmCapability(context:RepositoryContext,input:{capability:Capability;purpose?:'answer'|'embedding';mailboxId?:string},runtime?:CrmCapabilityRuntime){
 const s=await snapshot(context,input);if(s===null)return null;
 const revision=Number(s.row?.['revision']??0),enabled=s.row?.['enabled']===true;
 const ownerApprovalId=typeof s.row?.['owner_approval_id']==='string'?s.row['owner_approval_id']:null;
 const authority=s.configuration&&enabled&&ownerApprovalId?await verifyOwnerApproval(context,s.configuration,ownerApprovalId,runtime):null;
 const prepared=s.configuration&&context.scope.actor.kind==='user'&&s.configuration.ownerUserId===context.scope.actor.userId&&compatible(s.configuration,runtime);
 return {capability:input.capability,mailboxId:input.mailboxId??null,configured:s.row!==null,revision,enabled,ready:enabled?authority!==null:!!prepared,reason:authority?'ready':!s.configuration?'configuration_unavailable':!prepared?'adapter_or_configuration_unavailable':enabled?'owner_consent_unavailable':'owner_consent_required',authorityReceiptId:null,ownerApprovalId,qualityTier:authority?.qualityTier??null,limitations:authority?.limitations??[],proposedRevision:revision+1,proposedConfigurationFingerprint:null,configuration:s.configuration};
}
async function modify(context:RepositoryContext,input:{capability:Capability;purpose?:'answer'|'embedding';mailboxId?:string;expectedRevision:number;approval?:CrmOwnerApproval},enabled:boolean,runtime?:CrmCapabilityRuntime){
 const actor=context.scope.actor;if(actor.kind!=='user'||actor.role!=='admin'||!await activeIdentityActor(context))return {ok:false as const,reason:'capability_access_denied'};
 await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${context.scope.workspaceId}:crm-capability:${input.capability}:${input.mailboxId??''}`]);const s=await snapshot(context,input,true);
 if(!s?.row||enabled&&!s.configuration)return {ok:false as const,reason:'configuration_unavailable'};
 if(String(s.row[s.acquisition?'owner_user_id':'approved_by'])!==actor.userId)return {ok:false as const,reason:'capability_owner_required'};
 if(Number(s.row['revision'])!==input.expectedRevision)return {ok:false as const,reason:'capability_revision_conflict'};
 let ownerApprovalId:string|null=null;
 if(enabled){
  const approval=input.approval;
  if(!approval?.consentAcknowledged||!compatible(s.configuration!,runtime))return {ok:false as const,reason:'owner_consent_unavailable'};
  const ai=input.capability==='crm_extraction'||input.capability==='ask_answer';
  if(ai&&(approval.qualityTier==='acquisition'||!approval.criticalControlsPassed||!approval.modelIntegrationVerified||!approval.reviewedEvaluationReference||approval.qualityTier==='provisional_owner'&&!approval.limitations.includes('representative_quality_unverified')))return {ok:false as const,reason:'quality_review_required'};
  if(!ai&&approval.qualityTier!=='acquisition')return {ok:false as const,reason:'quality_scope_mismatch'};
  const configuration={...s.configuration!,revision:input.expectedRevision+1};
  const row=(await context.db.query<{id:string}>(`INSERT INTO crm_capability_owner_approvals(workspace_id,owner_user_id,capability,configuration_sha256,quality_tier,evaluation_reference,limitations,critical_controls_attested,model_integration_attested) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,[context.scope.workspaceId,actor.userId,input.capability,crmCapabilityConfigurationFingerprint(configuration),approval.qualityTier,approval.reviewedEvaluationReference??null,approval.limitations,approval.criticalControlsPassed===true,approval.modelIntegrationVerified===true])).rows[0];
  if(!row)throw new Error('owner approval insert failed');ownerApprovalId=row.id;
  if(!await verifyOwnerApproval(context,configuration,ownerApprovalId,runtime))return {ok:false as const,reason:'owner_consent_unavailable'};
 }
 if(!await activeIdentityActor(context))return {ok:false as const,reason:'capability_access_denied'};
 await context.db.query(`UPDATE ${s.table} SET enabled=$2,revision=revision+1,authority_receipt_id=NULL,owner_approval_id=$3 WHERE workspace_id=$1 ${s.acquisition?'AND mailbox_id=$4':input.capability==='ask_answer'?"AND purpose=$4":''}`,[context.scope.workspaceId,enabled,ownerApprovalId,...s.acquisition?[input.mailboxId]:input.capability==='ask_answer'?[input.purpose??'answer']:[]]);
 return {ok:true as const,value:{revision:input.expectedRevision+1,enabled,authorityReceiptId:null,ownerApprovalId}};
}
export function activateCrmCapability(context:RepositoryContext,input:{capability:Capability;purpose?:'answer'|'embedding';mailboxId?:string;expectedRevision:number;approval:CrmOwnerApproval},runtime?:CrmCapabilityRuntime){return modify(context,input,true,runtime);}
export function disableCrmCapability(context:RepositoryContext,input:{capability:Capability;purpose?:'answer'|'embedding';mailboxId?:string;expectedRevision:number}){return modify(context,input,false);}
export async function saveCrmMailCaptureControls(context:RepositoryContext,input:Omit<ReturnType<typeof crmMailCaptureControlsSaveSchema.parse>,'commandId'|'clientVersion'>){
 const actor=context.scope.actor;if(actor.kind!=='user'||actor.role!=='admin'||!await activeIdentityActor(context))return {ok:false as const,reason:'capability_access_denied'};
 await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${context.scope.workspaceId}:crm-capability:mail_capture:${input.mailboxId}`]);
 const m=(await context.db.query<{[key:string]:unknown;id:string;owner_user_id:string;email_address:string;provider_account_id:string;generation:number;status:string}>('SELECT * FROM mailboxes WHERE workspace_id=$1 AND id=$2 FOR SHARE',[context.scope.workspaceId,input.mailboxId])).rows[0];if(!m||m.owner_user_id!==actor.userId||m.status!=='connected'||m.generation!==input.expectedGeneration||businessAccountBinding(context.scope.workspaceId,m)!==input.expectedAccountBinding)return {ok:false as const,reason:'mailbox_binding_changed'};
 const current=(await context.db.query<{revision:number}>('SELECT revision FROM crm_mail_capture_controls WHERE workspace_id=$1 AND mailbox_id=$2 FOR UPDATE',[context.scope.workspaceId,m.id])).rows[0];if((current?.revision??0)!==input.expectedRevision)return {ok:false as const,reason:'capability_revision_conflict'};
 await context.db.query(`INSERT INTO crm_mail_capture_controls(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled,policy_revision,disclosure_version,disclosure_sha256,grant_receipt,provider_policy_receipt,evaluation_receipt,release_receipt) VALUES($1,$2,$3,$4,$5,$6,$7,false,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(workspace_id,mailbox_id) DO UPDATE SET owner_user_id=EXCLUDED.owner_user_id,provider_account_id=EXCLUDED.provider_account_id,account_binding=EXCLUDED.account_binding,generation=EXCLUDED.generation,revision=EXCLUDED.revision,enabled=false,authority_receipt_id=NULL,owner_approval_id=NULL,policy_revision=EXCLUDED.policy_revision,disclosure_version=EXCLUDED.disclosure_version,disclosure_sha256=EXCLUDED.disclosure_sha256,grant_receipt=EXCLUDED.grant_receipt,provider_policy_receipt=EXCLUDED.provider_policy_receipt,evaluation_receipt=EXCLUDED.evaluation_receipt,release_receipt=EXCLUDED.release_receipt`,[context.scope.workspaceId,m.id,actor.userId,m.provider_account_id,input.expectedAccountBinding,m.generation,input.expectedRevision+1,input.policyRevision,input.disclosureVersion,input.disclosureSha256,input.grantReceipt??null,input.providerPolicyReceipt??null,input.evaluationReceipt??null,input.releaseReceipt??null]);return {ok:true as const,value:{revision:input.expectedRevision+1,enabled:false}};
}
export async function saveCrmAskPurpose(context:RepositoryContext,input:Omit<ReturnType<typeof crmAskPurposeSaveSchema.parse>,'commandId'|'clientVersion'>){
 const actor=context.scope.actor;if(actor.kind!=='user'||actor.role!=='admin'||!await activeIdentityActor(context))return {ok:false as const,reason:'capability_access_denied'};if(input.enabled)return {ok:false as const,reason:'activation_not_available'};
 await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${context.scope.workspaceId}:crm-capability:ask_answer:`]);const current=(await context.db.query<{revision:number}>('SELECT revision FROM crm_ask_purposes WHERE workspace_id=$1 AND purpose=$2 FOR UPDATE',[context.scope.workspaceId,input.purpose])).rows[0];if((current?.revision??0)!==input.expectedRevision)return {ok:false as const,reason:'capability_revision_conflict'};
 await context.db.query(`INSERT INTO crm_ask_purposes(workspace_id,purpose,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,evaluation_fingerprint,processor_version,retrieval_version,answer_version,support_version,chunker_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by,agent_limits,embedding_dimensions) VALUES($1,$2,$3,false,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20) ON CONFLICT(workspace_id,purpose) DO UPDATE SET revision=EXCLUDED.revision,enabled=false,authority_receipt_id=NULL,owner_approval_id=NULL,endpoint_id=EXCLUDED.endpoint_id,model_version=EXCLUDED.model_version,access_grant_version=EXCLUDED.access_grant_version,data_handling_version=EXCLUDED.data_handling_version,evaluation_fingerprint=EXCLUDED.evaluation_fingerprint,processor_version=EXCLUDED.processor_version,retrieval_version=EXCLUDED.retrieval_version,answer_version=EXCLUDED.answer_version,support_version=EXCLUDED.support_version,chunker_version=EXCLUDED.chunker_version,daily_ceiling_cents=EXCLUDED.daily_ceiling_cents,monthly_ceiling_cents=EXCLUDED.monthly_ceiling_cents,input_token_price_micros=EXCLUDED.input_token_price_micros,output_token_price_micros=EXCLUDED.output_token_price_micros,approved_by=EXCLUDED.approved_by,approved_at=now(),agent_limits=EXCLUDED.agent_limits,embedding_dimensions=EXCLUDED.embedding_dimensions`,[context.scope.workspaceId,input.purpose,input.expectedRevision+1,input.endpointId,input.modelVersion,input.accessGrantVersion,input.dataHandlingVersion,input.evaluationFingerprint,input.processorVersion,input.retrievalVersion,input.answerVersion,input.supportVersion,input.chunkerVersion,input.dailyCeilingCents,input.monthlyCeilingCents,input.inputTokenPriceMicros,input.outputTokenPriceMicros,actor.userId,input.agentLimits?JSON.stringify(input.agentLimits):null,input.embeddingDimensions??null]);return {ok:true as const,value:{revision:input.expectedRevision+1,enabled:false}};
}

/** Current enabled binding, not a proposed future revision. Runtime callers still recheck after waits. */
export async function verifyCurrentCrmCapability(context:RepositoryContext,input:{capability:Capability;purpose?:'answer'|'embedding';mailboxId?:string},runtime?:CrmCapabilityRuntime){
 const s=await snapshot(context,input,'share');if(!s?.configuration||s.row?.['enabled']!==true||typeof s.row['owner_approval_id']!=='string'||context.scope.actor.kind!=='user'||s.configuration.ownerUserId!==context.scope.actor.userId)return null;
 return verifyOwnerApproval(context,s.configuration,s.row['owner_approval_id'],runtime);
}
