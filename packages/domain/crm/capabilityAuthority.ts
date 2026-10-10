import {createHash} from 'node:crypto';
import {crmCapabilityAuthorityReceiptSchema,crmCapabilityConfigurationSchema,type crmMailCaptureControlsSaveSchema,type crmAskPurposeSaveSchema,type CrmCapabilityAuthorityReceipt,type CrmCapabilityConfiguration} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {withTransaction,type SessionQueryable} from '../db/queryable.ts';
import {activeIdentityActor} from './identityAccess.ts';
import {METADATA_REVIEW_DISCLOSURE,businessAccountBinding} from '../business/acquisition.ts';
import {MAIL_CAPTURE_VERSION} from '../mail/crmSources.ts';
import {GMAIL_SCOPES} from '../mail/types.ts';
export const CRM_SUPPORTED_ASK_VERSIONS=Object.freeze({processorVersion:'ask-answer-v1',retrievalVersion:'lexical-original-v1',answerVersion:'literal-v1',supportVersion:'exact-original-v1',chunkerVersion:'lexical-original-v1'});
export const CRM_MAIL_CAPTURE_DISCLOSURE_TEXT='Callie may retain approved business email bodies, including incoming messages and original Sent replies, under the selected owner/account policy. Personal and excluded mail is not automatically copied. Disconnect stops acquisition but preserves approved copies; explicit deletion erases copied content and dependent evidence without deleting Gmail originals. Historical import is bounded and reports incomplete coverage. Hosted AI requires separate purpose, data handling, evaluation and budget approval. This consent does not authorize sending.';
export const CRM_MAIL_CAPTURE_DISCLOSURE=Object.freeze({version:'crm-mail-body-acquisition-v1',sha256:createHash('sha256').update(CRM_MAIL_CAPTURE_DISCLOSURE_TEXT).digest('hex')});
type Capability=CrmCapabilityConfiguration['capability'];
export interface CrmCapabilityRuntime {implementationCommit:string|null;imageDigest:string|null;side:'api'|'worker';schemaVersion:number;adapterAvailable(configuration:CrmCapabilityConfiguration):boolean}
export function crmCapabilityConfigurationFingerprint(configuration:CrmCapabilityConfiguration){return createHash('sha256').update(JSON.stringify(crmCapabilityConfigurationSchema.parse(configuration))).digest('hex');}
function internallyConsistent(r:CrmCapabilityAuthorityReceipt){
 return r.proof.evaluationConfigurationFingerprint===r.configurationFingerprint&&(r.configuration.capability!=='ask_answer'||r.configuration.evaluationFingerprint===r.proof.evaluationFingerprint)&&(r.configuration.capability!=='mail_capture'||r.configuration.evaluationReceipt===r.proof.evaluationReference);
}
export function crmCapabilityAuthorityFingerprint(receipt:CrmCapabilityAuthorityReceipt){return createHash('sha256').update(JSON.stringify(crmCapabilityAuthorityReceiptSchema.parse(receipt))).digest('hex');}
async function trusted(session:SessionQueryable){return (await session.query<{allowed:boolean}>("SELECT pg_has_role(current_user,'migration','MEMBER') AS allowed")).rows[0]?.allowed===true;}
export async function provisionCrmCapabilityAuthority(session:SessionQueryable,input:CrmCapabilityAuthorityReceipt){
 if(!await trusted(session))return {ok:false as const,reason:'authority_provision_denied'};
 const parsed=crmCapabilityAuthorityReceiptSchema.safeParse(input);if(!parsed.success)return {ok:false as const,reason:'authority_malformed'};
 const r=parsed.data;if(!internallyConsistent(r)||crmCapabilityConfigurationFingerprint(r.configuration)!==r.configurationFingerprint)return {ok:false as const,reason:'authority_fingerprint_mismatch'};
 return withTransaction(session,async()=>{
 await session.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`crm-authority:${r.configuration.workspaceId}:${r.id}`]);
 const fingerprint=crmCapabilityAuthorityFingerprint(r);const previous=(await session.query<{authority_sha256:string}>('SELECT authority_sha256 FROM crm_capability_authority_receipts WHERE workspace_id=$1 AND id=$2',[r.configuration.workspaceId,r.id])).rows[0];
 if(previous)return previous.authority_sha256===fingerprint?{ok:true as const,value:{authorityReceiptId:r.id}}:{ok:false as const,reason:'authority_conflict'};
 await session.query(`INSERT INTO crm_capability_authority_receipts(workspace_id,id,capability,owner_user_id,configuration_sha256,authority_sha256,receipt,reviewed_by,review_reference,verified_at,valid_until) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)`,[r.configuration.workspaceId,r.id,r.configuration.capability,r.configuration.ownerUserId,r.configurationFingerprint,fingerprint,JSON.stringify(r),r.reviewedBy,r.reviewReference,r.verifiedAt,r.validUntil]);
 return {ok:true as const,value:{authorityReceiptId:r.id}};});
}
export async function revokeCrmCapabilityAuthority(session:SessionQueryable,input:{workspaceId:string;authorityReceiptId:string;reference:string}){
 if(!await trusted(session))return {ok:false as const,reason:'authority_provision_denied'};
 if(!input.reference||input.reference.length>200)return {ok:false as const,reason:'authority_malformed'};
 return withTransaction(session,async()=>{await session.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`crm-authority:${input.workspaceId}:${input.authorityReceiptId}`]);const r=await session.query('UPDATE crm_capability_authority_receipts SET revoked_at=clock_timestamp(),revocation_reference=$3 WHERE workspace_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING id',[input.workspaceId,input.authorityReceiptId,input.reference]);return {ok:true as const,value:{revoked:r.rows.length===1}};});
}
const tables={metadata_review:'crm_business_policies',mail_capture:'crm_mail_capture_controls',crm_extraction:'crm_extraction_purposes',ask_answer:'crm_ask_purposes'} as const;
async function snapshot(context:RepositoryContext,input:{capability:Capability;mailboxId?:string},lock:boolean|'share'=false){
 if(context.scope.actor.kind!=='user'||!await activeIdentityActor(context)||input.capability==='mail_backfill')return null;
 const capability=input.capability;const table=tables[capability];const acquisition=capability==='metadata_review'||capability==='mail_capture';
 if(acquisition&&!input.mailboxId)return null;
 const row=(await context.db.query<Record<string,unknown>>(`SELECT * FROM ${table} WHERE workspace_id=$1 ${acquisition?'AND mailbox_id=$2':capability==='ask_answer'?"AND purpose='answer'":''} ${lock==='share'?'FOR SHARE':lock?'FOR UPDATE':''}`,[context.scope.workspaceId,...acquisition?[input.mailboxId]:[]])).rows[0];
 if(!row)return {row:null,configuration:null,table,acquisition};
 const common={workspaceId:context.scope.workspaceId,ownerUserId:String(row[acquisition?'owner_user_id':'approved_by']),revision:Number(row['revision'])};let config:unknown;
 if(acquisition){
  const m=(await context.db.query<{[key:string]:unknown;id:string;owner_user_id:string;email_address:string;provider_account_id:string;generation:number;status:string}>('SELECT * FROM mailboxes WHERE workspace_id=$1 AND id=$2 FOR SHARE',[context.scope.workspaceId,input.mailboxId])).rows[0];
  if(!m||m.status!=='connected'||m.owner_user_id!==common.ownerUserId||m.provider_account_id!==row['provider_account_id']||m.generation!==row['generation']||businessAccountBinding(context.scope.workspaceId,m)!==row['account_binding'])return {row,configuration:null,table,acquisition};
  const mailbox={mailboxId:m.id,providerAccountId:m.provider_account_id,generation:m.generation,accountBinding:String(row['account_binding'])};
  config=capability==='metadata_review'?{...common,...mailbox,capability,disclosureVersion:row['disclosure_version'],disclosureSha256:row['disclosure_sha256'],scopeDays:90}:{...common,...mailbox,capability,policyRevision:Number(row['policy_revision']),disclosureVersion:row['disclosure_version'],disclosureSha256:row['disclosure_sha256'],grantReceipt:row['grant_receipt'],providerPolicyReceipt:row['provider_policy_receipt'],evaluationReceipt:row['evaluation_receipt'],releaseReceipt:row['release_receipt'],captureVersion:MAIL_CAPTURE_VERSION};
 }else{
  const route={endpointId:row['endpoint_id'],modelVersion:row['model_version'],accessGrantVersion:row['access_grant_version'],dataHandlingVersion:row['data_handling_version'],dailyCeilingCents:row['daily_ceiling_cents'],monthlyCeilingCents:row['monthly_ceiling_cents'],inputTokenPriceMicros:row['input_token_price_micros'],outputTokenPriceMicros:row['output_token_price_micros']};
  config=capability==='crm_extraction'?{...common,...route,capability,processorVersion:'crm-extract-v1'}:{...common,...route,capability,purpose:'answer',evaluationFingerprint:row['evaluation_fingerprint'],processorVersion:row['processor_version'],retrievalVersion:row['retrieval_version'],answerVersion:row['answer_version'],supportVersion:row['support_version'],chunkerVersion:row['chunker_version']};
 }
 const parsed=crmCapabilityConfigurationSchema.safeParse(config);return {row,configuration:parsed.success?parsed.data:null,table,acquisition};
}
export async function verifyCrmCapabilityAuthority(context:RepositoryContext,configuration:CrmCapabilityConfiguration,receiptId:string,runtime?:CrmCapabilityRuntime){
 if(runtime===undefined||runtime.implementationCommit===null||runtime.imageDigest===null)return null;
 try{if(!runtime.adapterAvailable(structuredClone(configuration)))return null;}catch{return null;}
 await context.db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[`crm-authority:${configuration.workspaceId}:${receiptId}`]);
 const row=(await context.db.query<{receipt:unknown;authority_sha256:string}>(`SELECT receipt,authority_sha256 FROM crm_capability_authority_receipts WHERE workspace_id=$1 AND id=$2 AND revoked_at IS NULL AND verified_at<=clock_timestamp() AND valid_until>clock_timestamp()`,[configuration.workspaceId,receiptId])).rows[0];
 const parsed=crmCapabilityAuthorityReceiptSchema.safeParse(row?.receipt);if(!parsed.success)return null;const r=parsed.data;
 if(!internallyConsistent(r)||row?.authority_sha256!==crmCapabilityAuthorityFingerprint(r)||r.configurationFingerprint!==crmCapabilityConfigurationFingerprint(configuration)||crmCapabilityConfigurationFingerprint(r.configuration)!==r.configurationFingerprint)return null;
 const ai=configuration.capability==='crm_extraction'||configuration.capability==='ask_answer';if(r.proof.evaluationKind!==(ai?'actual_representative':'actual_acceptance')||ai&&r.proof.fundingReference===null)return null;

 if(configuration.capability==='metadata_review'&&(configuration.disclosureVersion!==METADATA_REVIEW_DISCLOSURE.version||configuration.disclosureSha256!==METADATA_REVIEW_DISCLOSURE.sha256))return null;
 if(configuration.capability==='mail_capture'&&(configuration.disclosureVersion!==CRM_MAIL_CAPTURE_DISCLOSURE.version||configuration.disclosureSha256!==CRM_MAIL_CAPTURE_DISCLOSURE.sha256))return null;
 if(configuration.capability==='ask_answer'&&Object.entries(CRM_SUPPORTED_ASK_VERSIONS).some(([key,value])=>configuration[key as keyof typeof CRM_SUPPORTED_ASK_VERSIONS]!==value))return null;
 if(configuration.capability==='crm_extraction'&&configuration.processorVersion!=='crm-extract-v1')return null;
 const release=r.proof.release;if(release.schemaVersion!==runtime.schemaVersion||release.implementationCommit!==runtime.implementationCommit||(runtime.side==='api'?release.apiImageDigest:release.workerImageDigest)!==runtime.imageDigest)return null;
 const stored=(await context.db.query<{record:Record<string,unknown>}>('SELECT record FROM release_records WHERE reference=$1 AND api_digest=$2 AND worker_digest=$3 AND desktop_commit_stamp=$4',[release.reference,release.apiImageDigest,release.workerImageDigest,release.implementationCommit])).rows[0];
 if(stored?.record['source']!=='ci-gate')return null;
 const member=(await context.db.query<{status:string;role:string}>('SELECT status,role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[configuration.workspaceId,configuration.ownerUserId])).rows[0];if(member?.status!=='active'||context.scope.actor.kind!=='user'||member.role!==context.scope.actor.role||configuration.ownerUserId!==context.scope.actor.userId)return null;
 if('mailboxId' in configuration){
  if(r.proof.oauthGrantObservationId===null)return null;
  const grant=(await context.db.query<{granted_scopes:string[]}>('SELECT granted_scopes FROM mailbox_oauth_grant_observations WHERE workspace_id=$1 AND id=$2 AND mailbox_id=$3 AND owner_user_id=$4 AND provider_account_id=$5 AND generation=$6',[configuration.workspaceId,r.proof.oauthGrantObservationId,configuration.mailboxId,configuration.ownerUserId,configuration.providerAccountId,configuration.generation])).rows[0];if(!grant||!GMAIL_SCOPES.every(scope=>grant.granted_scopes.includes(scope)))return null;
  if(configuration.capability==='mail_capture'){
   const policy=(await snapshot(context,{capability:'metadata_review',mailboxId:configuration.mailboxId},'share'));if(!policy?.configuration||policy.configuration.revision!==configuration.policyRevision||policy.row?.['enabled']!==true||typeof policy.row['authority_receipt_id']!=='string'||!await verifyCrmCapabilityAuthority(context,policy.configuration,policy.row['authority_receipt_id'],runtime))return null;
  }
 }
 return r;
}
export async function readCrmCapability(context:RepositoryContext,input:{capability:Capability;mailboxId?:string},runtime?:CrmCapabilityRuntime){
 const s=await snapshot(context,input);if(s===null)return null;const revision=Number(s.row?.['revision']??0),enabled=s.row?.['enabled']===true;const next=s.configuration?{...s.configuration,revision:revision+1}:null;const fingerprint=next?crmCapabilityConfigurationFingerprint(next):null;
 let receiptId=typeof s.row?.['authority_receipt_id']==='string'?s.row['authority_receipt_id']:null;
 if(!enabled&&fingerprint){receiptId=(await context.db.query<{id:string}>('SELECT id FROM crm_capability_authority_receipts WHERE workspace_id=$1 AND configuration_sha256=$2 AND revoked_at IS NULL ORDER BY verified_at DESC LIMIT 1',[context.scope.workspaceId,fingerprint])).rows[0]?.id??null;}
 const cfg=enabled?s.configuration:next;const authority=cfg&&receiptId&&context.scope.actor.kind==='user'&&cfg.ownerUserId===context.scope.actor.userId?await verifyCrmCapabilityAuthority(context,cfg,receiptId,runtime):null;
 return {capability:input.capability,mailboxId:input.mailboxId??null,configured:s.row!==null,revision,enabled,ready:authority!==null,reason:authority?'ready':s.configuration?'authority_unavailable':'configuration_unavailable',authorityReceiptId:receiptId,proposedRevision:revision+1,proposedConfigurationFingerprint:fingerprint,configuration:s.configuration};
}
async function modify(context:RepositoryContext,input:{capability:Capability;mailboxId?:string;expectedRevision:number;authorityReceiptId?:string},enabled:boolean,runtime?:CrmCapabilityRuntime){
 const actor=context.scope.actor;if(actor.kind!=='user'||actor.role!=='admin'||!await activeIdentityActor(context))return {ok:false as const,reason:'capability_access_denied'};
 await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${context.scope.workspaceId}:crm-capability:${input.capability}:${input.mailboxId??''}`]);const s=await snapshot(context,input,true);
 if(!s?.row||enabled&&!s.configuration)return {ok:false as const,reason:'configuration_unavailable'};
 if(String(s.row[s.acquisition?'owner_user_id':'approved_by'])!==actor.userId)return {ok:false as const,reason:'capability_owner_required'};
 if(Number(s.row['revision'])!==input.expectedRevision)return {ok:false as const,reason:'capability_revision_conflict'};
 if(enabled&&!await verifyCrmCapabilityAuthority(context,{...s.configuration!,revision:input.expectedRevision+1},input.authorityReceiptId??'',runtime))return {ok:false as const,reason:'authority_unavailable'};
 if(!await activeIdentityActor(context))return {ok:false as const,reason:'capability_access_denied'};
 await context.db.query(`UPDATE ${s.table} SET enabled=$2,revision=revision+1,authority_receipt_id=$3 WHERE workspace_id=$1 ${s.acquisition?'AND mailbox_id=$4':input.capability==='ask_answer'?"AND purpose='answer'":''}`,[context.scope.workspaceId,enabled,enabled?input.authorityReceiptId:null,...s.acquisition?[input.mailboxId]:[]]);
 return {ok:true as const,value:{revision:input.expectedRevision+1,enabled,authorityReceiptId:enabled?input.authorityReceiptId:null}};
}
export function activateCrmCapability(context:RepositoryContext,input:{capability:Capability;mailboxId?:string;expectedRevision:number;authorityReceiptId:string},runtime?:CrmCapabilityRuntime){return modify(context,input,true,runtime);}
export function disableCrmCapability(context:RepositoryContext,input:{capability:Capability;mailboxId?:string;expectedRevision:number}){return modify(context,input,false);}
export async function saveCrmMailCaptureControls(context:RepositoryContext,input:Omit<ReturnType<typeof crmMailCaptureControlsSaveSchema.parse>,'commandId'|'clientVersion'>){
 const actor=context.scope.actor;if(actor.kind!=='user'||actor.role!=='admin'||!await activeIdentityActor(context))return {ok:false as const,reason:'capability_access_denied'};
 await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${context.scope.workspaceId}:crm-capability:mail_capture:${input.mailboxId}`]);
 const m=(await context.db.query<{[key:string]:unknown;id:string;owner_user_id:string;email_address:string;provider_account_id:string;generation:number;status:string}>('SELECT * FROM mailboxes WHERE workspace_id=$1 AND id=$2 FOR SHARE',[context.scope.workspaceId,input.mailboxId])).rows[0];if(!m||m.owner_user_id!==actor.userId||m.status!=='connected'||m.generation!==input.expectedGeneration||businessAccountBinding(context.scope.workspaceId,m)!==input.expectedAccountBinding)return {ok:false as const,reason:'mailbox_binding_changed'};
 const current=(await context.db.query<{revision:number}>('SELECT revision FROM crm_mail_capture_controls WHERE workspace_id=$1 AND mailbox_id=$2 FOR UPDATE',[context.scope.workspaceId,m.id])).rows[0];if((current?.revision??0)!==input.expectedRevision)return {ok:false as const,reason:'capability_revision_conflict'};
 await context.db.query(`INSERT INTO crm_mail_capture_controls(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled,policy_revision,disclosure_version,disclosure_sha256,grant_receipt,provider_policy_receipt,evaluation_receipt,release_receipt) VALUES($1,$2,$3,$4,$5,$6,$7,false,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(workspace_id,mailbox_id) DO UPDATE SET owner_user_id=EXCLUDED.owner_user_id,provider_account_id=EXCLUDED.provider_account_id,account_binding=EXCLUDED.account_binding,generation=EXCLUDED.generation,revision=EXCLUDED.revision,enabled=false,authority_receipt_id=NULL,policy_revision=EXCLUDED.policy_revision,disclosure_version=EXCLUDED.disclosure_version,disclosure_sha256=EXCLUDED.disclosure_sha256,grant_receipt=EXCLUDED.grant_receipt,provider_policy_receipt=EXCLUDED.provider_policy_receipt,evaluation_receipt=EXCLUDED.evaluation_receipt,release_receipt=EXCLUDED.release_receipt`,[context.scope.workspaceId,m.id,actor.userId,m.provider_account_id,input.expectedAccountBinding,m.generation,input.expectedRevision+1,input.policyRevision,input.disclosureVersion,input.disclosureSha256,input.grantReceipt,input.providerPolicyReceipt,input.evaluationReceipt,input.releaseReceipt]);return {ok:true as const,value:{revision:input.expectedRevision+1,enabled:false}};
}
export async function saveCrmAskPurpose(context:RepositoryContext,input:Omit<ReturnType<typeof crmAskPurposeSaveSchema.parse>,'commandId'|'clientVersion'>){
 const actor=context.scope.actor;if(actor.kind!=='user'||actor.role!=='admin'||!await activeIdentityActor(context))return {ok:false as const,reason:'capability_access_denied'};if(input.enabled)return {ok:false as const,reason:'activation_not_available'};
 await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${context.scope.workspaceId}:crm-capability:ask_answer:`]);const current=(await context.db.query<{revision:number}>('SELECT revision FROM crm_ask_purposes WHERE workspace_id=$1 AND purpose=$2 FOR UPDATE',[context.scope.workspaceId,input.purpose])).rows[0];if((current?.revision??0)!==input.expectedRevision)return {ok:false as const,reason:'capability_revision_conflict'};
 await context.db.query(`INSERT INTO crm_ask_purposes(workspace_id,purpose,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,evaluation_fingerprint,processor_version,retrieval_version,answer_version,support_version,chunker_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) VALUES($1,$2,$3,false,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT(workspace_id,purpose) DO UPDATE SET revision=EXCLUDED.revision,enabled=false,authority_receipt_id=NULL,endpoint_id=EXCLUDED.endpoint_id,model_version=EXCLUDED.model_version,access_grant_version=EXCLUDED.access_grant_version,data_handling_version=EXCLUDED.data_handling_version,evaluation_fingerprint=EXCLUDED.evaluation_fingerprint,processor_version=EXCLUDED.processor_version,retrieval_version=EXCLUDED.retrieval_version,answer_version=EXCLUDED.answer_version,support_version=EXCLUDED.support_version,chunker_version=EXCLUDED.chunker_version,daily_ceiling_cents=EXCLUDED.daily_ceiling_cents,monthly_ceiling_cents=EXCLUDED.monthly_ceiling_cents,input_token_price_micros=EXCLUDED.input_token_price_micros,output_token_price_micros=EXCLUDED.output_token_price_micros,approved_by=EXCLUDED.approved_by,approved_at=now()`,[context.scope.workspaceId,input.purpose,input.expectedRevision+1,input.endpointId,input.modelVersion,input.accessGrantVersion,input.dataHandlingVersion,input.evaluationFingerprint,input.processorVersion,input.retrievalVersion,input.answerVersion,input.supportVersion,input.chunkerVersion,input.dailyCeilingCents,input.monthlyCeilingCents,input.inputTokenPriceMicros,input.outputTokenPriceMicros,actor.userId]);return {ok:true as const,value:{revision:input.expectedRevision+1,enabled:false}};
}

/** Current enabled binding, not a proposed future revision. Runtime callers still recheck after waits. */
export async function verifyCurrentCrmCapability(context:RepositoryContext,input:{capability:Capability;mailboxId?:string},runtime?:CrmCapabilityRuntime){
 const s=await snapshot(context,input,'share');if(!s?.configuration||s.row?.['enabled']!==true||typeof s.row['authority_receipt_id']!=='string'||context.scope.actor.kind!=='user'||s.configuration.ownerUserId!==context.scope.actor.userId)return null;
 return verifyCrmCapabilityAuthority(context,s.configuration,s.row['authority_receipt_id'],runtime);
}
