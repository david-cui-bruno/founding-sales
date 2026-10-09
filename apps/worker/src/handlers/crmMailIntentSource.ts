import {createHash} from 'node:crypto';
import type {DueWorkSource} from '../scheduler/schedulerPass.ts';
import type {CrmMailEvidencePort} from '@fss/domain/crm/mailEvidence.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {processingContextHash} from '@fss/domain/crm/processingContext.ts';
/** Bounded nonlocking DB hints only; no copied input or external verifier here. */
export function crmMailIntentSource(port:CrmMailEvidencePort):DueWorkSource{return {name:'crm-mail-intents',async find(session){
 const rows=(await session.query<{workspace_id:string;id:string;source_id:string;source_revision:number;content_hash:string;owner_user_id:string;role:'admin'|'salesperson';purpose_revision:number}>(`SELECT i.*,s.owner_user_id,m.role,p.revision AS purpose_revision FROM crm_mail_source_intents i JOIN crm_mail_sources s ON s.workspace_id=i.workspace_id AND s.source_id=i.source_id AND s.source_revision=i.source_revision AND s.content_hash=i.content_hash JOIN workspace_memberships m ON m.workspace_id=s.workspace_id AND m.user_id=s.owner_user_id JOIN crm_extraction_purposes p ON p.workspace_id=s.workspace_id WHERE i.state='pending' AND s.availability='available' AND m.status='active' AND p.enabled ORDER BY i.workspace_id,i.id LIMIT 100`)).rows;
 const due=[];
 for(const row of rows){
  const context=repositoryContext(workspaceScope(row.workspace_id,{kind:'user',userId:row.owner_user_id,role:row.role}),session);
  const source={workspaceId:row.workspace_id,sourceId:row.source_id,kind:'mail' as const,revision:row.source_revision,contentHash:row.content_hash,locator:null};
  const hint=await port.snapshotProcessing(context,source,row.owner_user_id);if(hint===null)continue;
  const payload={stage:'mail_intent',intentId:row.id,source,ownerUserId:row.owner_user_id,purposeRevision:row.purpose_revision,contextHash:processingContextHash(hint.context),expectedAuthorizationFingerprint:hint.authorizationFingerprint};
  const key=`crm-mail-intent:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
  if((await session.query('SELECT 1 FROM jobs WHERE workspace_id=$1 AND kind=$2 AND idempotency_key=$3',[row.workspace_id,'crm.capture_extraction',key])).rows.length)continue;
  due.push({workspaceId:row.workspace_id,kind:'crm.capture_extraction' as const,idempotencyKey:key,payload,maxAttempts:3});
 }
 return due;
}};}
