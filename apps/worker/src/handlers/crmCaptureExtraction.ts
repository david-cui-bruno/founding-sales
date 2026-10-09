import {z} from 'zod';
import type {JobHandler} from '@fss/domain/jobs/handlerRegistry.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {materializeNativeCrmExtraction} from '@fss/domain/crm/processingCapture.ts';
import {requestCrmProcessing} from '@fss/domain/crm/processing.ts';
import {processingContextHash} from '@fss/domain/crm/processingContext.ts';
import {unavailableMailEvidence,type CrmMailEvidencePort} from '@fss/domain/crm/mailEvidence.ts';
const hash=z.string().regex(/^[a-f0-9]{64}$/u);
const sourceSchema=z.strictObject({workspaceId:z.string().uuid(),sourceId:z.string().uuid(),kind:z.enum(['call_transcript','meeting_transcript']),revision:z.number().int().positive(),contentHash:hash,locator:z.null()});
const nativeSchema=z.strictObject({source:sourceSchema,ownerUserId:z.string().uuid(),originalFirmId:z.string().uuid(),contextHash:hash,purposeRevision:z.number().int().positive()});
const mailSchema=z.strictObject({stage:z.literal('mail_intent'),intentId:z.string().uuid(),source:sourceSchema.extend({kind:z.literal('mail')}),ownerUserId:z.string().uuid(),contextHash:hash,purposeRevision:z.number().int().positive(),expectedAuthorizationFingerprint:hash});
/** Proof waits occur outside transactions; both variants own short fenced commits. */
export function crmCaptureExtractionJobHandler(port:CrmMailEvidencePort=unavailableMailEvidence):JobHandler{return {kind:'crm.capture_extraction',protection:'outbound_fence',maxAttempts:3,leaseSeconds:60,handle:async input=>{
 const fence=async()=> (await input.session.query(`SELECT id FROM jobs WHERE workspace_id=$1 AND id=$2 AND state='running' AND lease_owner=$3 AND fencing_token=$4::bigint AND lease_expires_at>clock_timestamp() FOR UPDATE`,[input.scope.workspaceId,input.job.id,input.job.leaseOwner,input.job.fencingToken])).rows.length===1;
 const mail=mailSchema.safeParse(input.job.payload);
 if(mail.success){
  const data=mail.data;if(data.source.workspaceId!==input.scope.workspaceId)return;
  const membership=(await input.session.query<{role:'admin'|'salesperson';status:string}>('SELECT role,status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',[input.scope.workspaceId,data.ownerUserId])).rows[0];if(membership?.status!=='active')return;
  const context=repositoryContext(workspaceScope(input.scope.workspaceId,{kind:'user',userId:data.ownerUserId,role:membership.role}),input.session);
  const verified=await port.authorizeProcessing(context,data.source,data.ownerUserId);
  if(verified===null||verified.authorizationFingerprint!==data.expectedAuthorizationFingerprint)return;
  await withTransaction(input.session,async()=>{
   if(!await port.revalidatePrepared(context,verified))return;
   const current=await port.readContext(context,data.source);if(current===null||processingContextHash(current)!==data.contextHash)return;
   const purpose=(await input.session.query<{enabled:boolean;revision:number}>('SELECT enabled,revision FROM crm_extraction_purposes WHERE workspace_id=$1 FOR SHARE',[input.scope.workspaceId])).rows[0];if(!purpose?.enabled||purpose.revision!==data.purposeRevision)return;
   const intent=(await input.session.query(`SELECT id FROM crm_mail_source_intents WHERE workspace_id=$1 AND id=$2 AND source_id=$3 AND source_revision=$4 AND content_hash=$5 AND state='pending' FOR UPDATE`,[input.scope.workspaceId,data.intentId,data.source.sourceId,data.source.revision,data.source.contentHash])).rows[0];if(intent===undefined||!await fence())return;
   if((await input.session.query(`SELECT 1 FROM crm_extraction_financial_receipts f JOIN crm_extraction_generations g ON g.workspace_id=f.workspace_id AND g.id=f.generation_id WHERE g.workspace_id=$1 AND g.source_kind='mail' AND g.source_id=$2 AND f.dispatch_state IN ('calling','unknown_acceptance') LIMIT 1`,[input.scope.workspaceId,data.source.sourceId])).rows.length)return;
   await requestCrmProcessing(context,data.source,port);
   await input.session.query("UPDATE crm_mail_source_intents SET state='consumed' WHERE workspace_id=$1 AND id=$2",[input.scope.workspaceId,data.intentId]);
  });return;
 }
 const parsed=nativeSchema.safeParse(input.job.payload);if(!parsed.success||parsed.data.source.workspaceId!==input.scope.workspaceId)return;
 await withTransaction(input.session,async()=>{await materializeNativeCrmExtraction(repositoryContext(input.scope,input.session),parsed.data,fence);});
}};}
