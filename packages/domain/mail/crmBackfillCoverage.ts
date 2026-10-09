import type {RepositoryContext} from '../db/workspaceScope.ts';
import {readMailCopyAvailabilityBatch} from './crmSources.ts';
interface CoverageRow extends Record<string,unknown>{id:string;state:string;source_id:string|null;review_required:boolean;pending_capture:boolean}
/** Exact retained causal identities, not provider totals or inferred inbox coverage. */
export async function readBackfillCopyCoverage(context:RepositoryContext,importId:string,total:string){
 const counts={retainedCopiedBodies:0n,unavailableCopies:0n,pendingCaptures:0n,reviewRequiredMetadata:0n,uncapturedMetadata:0n,unresolvedMetadata:0n};
 const dto=(complete:boolean)=>({scope:'permitted_import_corpus' as const,coverage:complete?'complete' as const:'partial' as const,retainedCopiedBodies:counts.retainedCopiedBodies.toString(),unavailableCopies:counts.unavailableCopies.toString(),pendingCaptures:counts.pendingCaptures.toString(),reviewRequiredMetadata:counts.reviewRequiredMetadata.toString(),uncapturedMetadata:counts.uncapturedMetadata.toString(),unresolvedMetadata:counts.unresolvedMetadata.toString()});
 const rows=(await context.db.query<CoverageRow>(`SELECT x.id,x.state,s.source_id,
  (v.metadata_availability='available' AND v.category='uncertain' AND v.human_decision IS NULL) IS TRUE AS review_required,
  EXISTS(SELECT 1 FROM jobs j JOIN mailboxes m ON m.workspace_id=i.workspace_id AND m.id=i.mailbox_id
   JOIN crm_mail_capture_controls ctl ON ctl.workspace_id=i.workspace_id AND ctl.mailbox_id=i.mailbox_id
   JOIN crm_business_policies pol ON pol.workspace_id=i.workspace_id AND pol.mailbox_id=i.mailbox_id
   JOIN crm_mail_import_allocations allocation ON allocation.workspace_id=i.workspace_id AND allocation.mailbox_id=i.mailbox_id
   WHERE j.workspace_id=i.workspace_id AND j.kind='crm.mail_capture' AND j.state IN('queued','retryable','running')
   AND j.payload->'acquisitionOrigin'->>'importId'=i.id::text AND j.payload->>'providerMessageId'=x.provider_message_id
   AND j.payload->>'mailboxId'=i.mailbox_id::text AND j.payload->>'providerAccountId'=i.provider_account_id
   AND j.payload->>'conversationId'=v.id::text AND j.payload->>'decisionRevision'=v.decision_revision::text
   AND j.payload->>'generation'=i.generation::text AND j.payload->>'controlsRevision'=i.controls_revision::text AND j.payload->>'policyRevision'=i.policy_revision::text
   AND s.source_id IS NULL AND c.state IS DISTINCT FROM 'copied' AND c.state IS DISTINCT FROM 'blocked'
   AND NOT EXISTS(SELECT 1 FROM crm_mail_acquisition_tombstones t WHERE t.workspace_id=i.workspace_id AND t.capture_identity_id=c.id)
   AND x.state='available' AND v.metadata_availability='available' AND (v.human_decision='include' OR (v.human_decision IS NULL AND v.category='business'))
   AND m.status='connected' AND m.owner_user_id=i.owner_user_id AND m.provider_account_id=i.provider_account_id AND m.generation=i.generation
   AND ctl.enabled AND ctl.provider_account_id=i.provider_account_id AND ctl.owner_user_id=i.owner_user_id AND ctl.account_binding=i.account_binding AND ctl.generation=i.generation AND ctl.revision=i.controls_revision AND ctl.policy_revision=i.policy_revision
   AND pol.enabled AND pol.provider_account_id=i.provider_account_id AND pol.owner_user_id=i.owner_user_id AND pol.account_binding=i.account_binding AND pol.generation=i.generation AND pol.revision=i.policy_revision
   AND allocation.owner_user_id=i.owner_user_id AND allocation.account_binding=i.account_binding AND allocation.generation=i.generation AND allocation.verified_until>clock_timestamp()) AS pending_capture
  FROM crm_mail_import_messages x JOIN crm_mail_imports i ON i.workspace_id=x.workspace_id AND i.id=x.import_id
  LEFT JOIN crm_mail_capture_identities c ON c.workspace_id=i.workspace_id AND c.mailbox_id=i.mailbox_id AND c.account_binding=i.account_binding AND c.provider_message_id=x.provider_message_id
   AND x.message_hash=encode(sha256(convert_to(format('{"accountBinding":"%s","providerMessageId":"%s"}',i.account_binding,c.provider_message_id),'UTF8')),'hex')
  LEFT JOIN crm_mail_sources s ON s.workspace_id=c.workspace_id AND s.capture_identity_id=c.id AND s.owner_user_id=i.owner_user_id AND s.account_binding=i.account_binding
  LEFT JOIN crm_business_conversations v ON v.workspace_id=i.workspace_id AND v.mailbox_id=i.mailbox_id AND v.owner_user_id=i.owner_user_id AND v.account_binding=i.account_binding AND v.provider_thread_id=x.provider_thread_id
  WHERE x.workspace_id=$1 AND x.import_id=$2 ORDER BY x.id LIMIT 101`,[context.scope.workspaceId,importId])).rows;
 if(rows.length>100){counts.unresolvedMetadata=BigInt(total);return dto(false);}
 const sources=await readMailCopyAvailabilityBatch(context,[...new Set(rows.flatMap(row=>row.source_id===null?[]:[row.source_id]))].sort());
 if(sources===null){counts.unresolvedMetadata=BigInt(total);return dto(false);}
 for(const row of rows){
  // Identifier redaction preserves an opaque veto, not a claim that no permitted copy exists.
  if(row.state==='deleted'){counts.unresolvedMetadata++;continue;}
  if(row.source_id!==null){
   const copy=sources.find(value=>value.sourceId===row.source_id);
   if(copy===undefined){counts.unresolvedMetadata++;continue;}
   if(copy.availability==='available'&&copy.bodyAvailable)counts.retainedCopiedBodies++;else counts.unavailableCopies++;
  }else if(row.state==='available')counts.uncapturedMetadata++;
  if(row.review_required)counts.reviewRequiredMetadata++;
  if(row.pending_capture)counts.pendingCaptures++;
 }
 return dto(counts.unresolvedMetadata===0n);
}
